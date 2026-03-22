import type {App} from "obsidian";
import type {CalendarEvent, CalendarProvider, EventAttendee} from "../types";

/** Serialized form of CalendarEvent with ISO date strings instead of Date objects. */
interface SerializedCalendarEvent {
	id: string;
	subject: string;
	body: string;
	isAllDay: boolean;
	isOnlineMeeting: boolean;
	onlineMeetingUrl: string;
	startTime: string;
	endTime: string;
	location: string;
	attendeeCount: number;
	attendees: EventAttendee[];
	organizerName: string;
	organizerEmail: string;
	isOrganizer?: boolean;
	isRecurring: boolean;
	responseStatus?: string;
}

interface CacheDayEntry {
	fetchedAt: number;
	events: SerializedCalendarEvent[];
}

interface CacheFileData {
	version: 1;
	days: Record<string, CacheDayEntry>;
}

export interface CacheStatus {
	source: "live" | "cache";
	fetchedAt: number | null;
	connected: boolean;
}

const CACHE_FILENAME = "calendar-cache.json";
const SAVE_DEBOUNCE_MS = 1000;
const PREFETCH_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour

/**
 * Wraps an upstream CalendarProvider with a persistent local cache.
 *
 * Past days are served from cache (never re-fetched unless missing).
 * Today and future days fetch live, falling back to cache when offline.
 * After a successful live fetch of today, future days are pre-fetched.
 */
export class CachedCalendarProvider implements CalendarProvider {
	private app: App;
	private upstream: CalendarProvider;
	private pluginDir: string;
	private cacheFutureDays: number;
	private cacheRetentionDays: number;
	private timezone: string;
	private cache: CacheFileData = {version: 1, days: {}};
	private dirty = false;
	private saveTimer: number | null = null;
	private lastStatus: CacheStatus = {source: "live", fetchedAt: null, connected: false};

	constructor(
		app: App,
		upstream: CalendarProvider,
		pluginDir: string,
		cacheFutureDays: number,
		cacheRetentionDays: number,
		timezone: string,
	) {
		this.app = app;
		this.upstream = upstream;
		this.pluginDir = pluginDir;
		this.cacheFutureDays = cacheFutureDays;
		this.cacheRetentionDays = cacheRetentionDays;
		this.timezone = timezone;
	}

	/** Load cache from disk. Call once on plugin load. */
	async loadCache(): Promise<void> {
		const path = this.cachePath();
		try {
			const exists = await this.app.vault.adapter.exists(path);
			if (!exists) return;
			const raw = await this.app.vault.adapter.read(path);
			const parsed = JSON.parse(raw) as CacheFileData;
			if (parsed.version === 1 && parsed.days) {
				this.cache = parsed;
			}
		} catch {
			// Corrupt or missing — start fresh
			this.cache = {version: 1, days: {}};
		}
	}

	async fetchEvents(date: Date, timezone: string): Promise<CalendarEvent[]> {
		const dateKey = this.toDateKey(date, timezone);
		const todayKey = this.toDateKey(new Date(), timezone);
		const isPast = dateKey < todayKey;

		// Past day with cache — serve from cache, never re-fetch
		const pastEntry = isPast ? this.cache.days[dateKey] : undefined;
		if (pastEntry) {
			this.lastStatus = {source: "cache", fetchedAt: pastEntry.fetchedAt, connected: false};
			return this.deserializeEvents(pastEntry.events);
		}

		// Try live fetch
		try {
			const available = await this.upstream.isAvailable();
			if (available) {
				const events = await this.upstream.fetchEvents(date, timezone);
				this.cacheDay(dateKey, events);
				this.lastStatus = {source: "live", fetchedAt: Date.now(), connected: true};

				// Pre-fetch future days after a successful today fetch
				if (dateKey === todayKey) {
					void this.prefetchFutureDays(timezone);
				}

				return events;
			}
		} catch (e) {
			// Live fetch failed — fall through to cache
			console.debug("[WhisperCal] Live fetch failed, trying cache:", e);
		}

		// Fallback to cache
		const cached = this.cache.days[dateKey];
		if (cached) {
			this.lastStatus = {source: "cache", fetchedAt: cached.fetchedAt, connected: false};
			return this.deserializeEvents(cached.events);
		}

		// No cache, no connection
		this.lastStatus = {source: "cache", fetchedAt: null, connected: false};
		return [];
	}

	async isAvailable(): Promise<boolean> {
		// Available if upstream is available OR we have any cache
		const upstreamAvailable = await this.upstream.isAvailable().catch(() => false);
		if (upstreamAvailable) return true;
		return Object.keys(this.cache.days).length > 0;
	}

	getLastStatus(): CacheStatus {
		return this.lastStatus;
	}

	updateConfig(cacheFutureDays: number, cacheRetentionDays: number, timezone: string): void {
		this.cacheFutureDays = cacheFutureDays;
		this.cacheRetentionDays = cacheRetentionDays;
		this.timezone = timezone;
	}

	/** Flush any pending cache writes to disk. Call on plugin unload. */
	async flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.dirty) {
			await this.writeCacheToDisk();
		}
	}

	// ---- Private ----

	private cachePath(): string {
		return `${this.pluginDir}/${CACHE_FILENAME}`;
	}

	private cacheDay(dateKey: string, events: CalendarEvent[]): void {
		this.cache.days[dateKey] = {
			fetchedAt: Date.now(),
			events: events.map(e => this.serializeEvent(e)),
		};
		this.dirty = true;
		this.scheduleSave();
	}

	private async prefetchFutureDays(timezone: string): Promise<void> {
		if (this.cacheFutureDays <= 0) return;

		const today = new Date();
		for (let i = 1; i <= this.cacheFutureDays; i++) {
			const futureDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
			const key = this.toDateKey(futureDate, timezone);

			// Skip if already cached recently (within 1 hour)
			const existing = this.cache.days[key];
			if (existing && Date.now() - existing.fetchedAt < PREFETCH_FRESHNESS_MS) continue;

			try {
				const events = await this.upstream.fetchEvents(futureDate, timezone);
				this.cacheDay(key, events);
			} catch {
				// Silently skip — pre-fetch is best-effort
			}
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.writeCacheToDisk();
		}, SAVE_DEBOUNCE_MS);
	}

	private async writeCacheToDisk(): Promise<void> {
		this.pruneOldEntries();
		this.dirty = false;
		try {
			const json = JSON.stringify(this.cache, null, "\t");
			await this.app.vault.adapter.write(this.cachePath(), json);
		} catch (e) {
			console.error("[WhisperCal] Failed to write cache:", e);
		}
	}

	private pruneOldEntries(): void {
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - this.cacheRetentionDays);
		const cutoffKey = this.toDateKey(cutoff, this.timezone);

		for (const key of Object.keys(this.cache.days)) {
			if (key < cutoffKey) {
				delete this.cache.days[key];
			}
		}
	}

	private serializeEvent(event: CalendarEvent): SerializedCalendarEvent {
		return {
			...event,
			startTime: event.startTime.toISOString(),
			endTime: event.endTime.toISOString(),
		};
	}

	private deserializeEvents(events: SerializedCalendarEvent[]): CalendarEvent[] {
		return events.map(e => ({
			...e,
			startTime: new Date(e.startTime),
			endTime: new Date(e.endTime),
			isOrganizer: e.isOrganizer ?? false,
			isRecurring: e.isRecurring ?? false,
			responseStatus: (e.responseStatus ?? "none") as CalendarEvent["responseStatus"],
		}));
	}

	private toDateKey(date: Date, timezone: string): string {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(date);
	}
}
