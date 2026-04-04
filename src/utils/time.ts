/**
 * Get midnight in a given timezone as a UTC Date.
 * Computes the UTC offset at actual midnight (not at the guess time)
 * to handle DST transitions correctly.
 */
function midnightInTimezone(date: Date, timezone: string): Date {
	// Get the calendar date in the target timezone
	const localDate = formatDate(date, timezone); // "YYYY-MM-DD"
	// Start with a rough guess: interpret as UTC midnight
	const guess = new Date(`${localDate}T00:00:00Z`);

	// Compute UTC offset at the guess time by comparing formatted local parts to UTC
	const computeOffset = (instant: Date): number => {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", second: "2-digit",
			hour12: false,
		}).formatToParts(instant);
		const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
		const localMs = Date.UTC(
			get("year"), get("month") - 1, get("day"),
			get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"),
		);
		return localMs - instant.getTime();
	};

	// First pass: compute offset at the guess
	const offset1 = computeOffset(guess);
	const midnight1 = new Date(guess.getTime() - offset1);
	// Second pass: verify the offset at the computed midnight (may differ on DST boundary)
	const offset2 = computeOffset(midnight1);
	if (offset1 === offset2) return midnight1;
	// Re-adjust with the correct offset
	return new Date(guess.getTime() - offset2);
}

/**
 * Get the start of a day in a given timezone as a UTC ISO string.
 * Used to build Graph API calendarView date range params.
 */
export function getDayStartUTC(date: Date, timezone: string): string {
	return midnightInTimezone(date, timezone).toISOString();
}

/**
 * Get the end of a day (start of next day) in a given timezone as a UTC ISO string.
 * Computes next-day midnight directly instead of adding fixed 24h (which is wrong on DST days).
 */
export function getDayEndUTC(date: Date, timezone: string): string {
	const nextDay = new Date(date.getTime() + 24 * 3600_000);
	return midnightInTimezone(nextDay, timezone).toISOString();
}

/**
 * Format a Date as a time string (e.g. "9:00 AM") in the given timezone.
 */
/** Configured time format — call setTimeFormat() from plugin onload. */
let configuredHour12: boolean | undefined;

/** Detect system hour cycle (h23/h24 = 24-hour, h11/h12 = 12-hour). */
function detectSystemHour12(): boolean {
	const resolved = new Intl.DateTimeFormat(undefined, {hour: "numeric"}).resolvedOptions();
	const hourCycle = (resolved as unknown as {hourCycle?: string}).hourCycle;
	return hourCycle === "h11" || hourCycle === "h12";
}

function resolveHour12(): boolean {
	if (configuredHour12 !== undefined) return configuredHour12;
	return detectSystemHour12();
}

/** Return the resolved hour12 flag for use in custom Intl formatters. */
export function getHour12(): boolean {
	return resolveHour12();
}

export function setTimeFormat(format: "auto" | "12h" | "24h"): void {
	if (format === "12h") configuredHour12 = true;
	else if (format === "24h") configuredHour12 = false;
	else configuredHour12 = undefined; // auto
}

export function formatTime(date: Date, timezone: string): string {
	return date.toLocaleTimeString(undefined, {
		timeZone: timezone,
		hour: "numeric",
		minute: "2-digit",
		hour12: resolveHour12(),
	});
}

/**
 * Format a Date as a local date string (e.g. "2026-02-28") in the given timezone.
 */
export function formatDate(date: Date, timezone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

/**
 * Format a Date as a readable date string for display (e.g. "Friday, February 28, 2026").
 */
export function formatDisplayDate(date: Date, timezone: string): string {
	return date.toLocaleDateString(undefined, {
		timeZone: timezone,
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

/**
 * Get today's date string in the given timezone ("YYYY-MM-DD").
 */
export function getTodayString(timezone: string): string {
	return formatDate(new Date(), timezone);
}

/**
 * Check whether two Dates fall on the same calendar day in the given timezone.
 */
export function isSameDay(a: Date, b: Date, timezone: string): boolean {
	return formatDate(a, timezone) === formatDate(b, timezone);
}

/**
 * Parse a date string ("YYYY-MM-DD") and a time string ("9:00 AM") into a Date.
 * Returns null if either part is missing or unparseable.
 */
export function parseDateTime(dateStr: string, timeStr: string): Date | null {
	const dateParts = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!dateParts) return null;

	const timeMatch12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
	const timeMatch24 = timeStr.match(/^(\d{1,2}):(\d{2})$/);
	if (!timeMatch12 && !timeMatch24) return null;

	let hour: number;
	let minute: number;
	if (timeMatch12) {
		hour = parseInt(timeMatch12[1]!, 10);
		minute = parseInt(timeMatch12[2]!, 10);
		const meridiem = timeMatch12[3]!.toUpperCase();
		if (meridiem === "PM" && hour !== 12) hour += 12;
		if (meridiem === "AM" && hour === 12) hour = 0;
	} else {
		hour = parseInt(timeMatch24![1]!, 10);
		minute = parseInt(timeMatch24![2]!, 10);
	}

	const d = new Date(
		parseInt(dateParts[1]!, 10),
		parseInt(dateParts[2]!, 10) - 1,
		parseInt(dateParts[3]!, 10),
		hour,
		minute,
	);
	return isNaN(d.getTime()) ? null : d;
}

/**
 * Return a promise that resolves after the given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format a duration in seconds as a human-readable string (e.g. "45 min", "1h 30m").
 * Returns empty string for non-positive values.
 */
/** Format elapsed seconds as a live counter: "0:05", "1:23", "1:05:23". */
export function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
	const ss = String(sec).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRecordingDuration(seconds: number): string {
	if (seconds <= 0) return "";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rem = minutes % 60;
	return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export function formatDateTimeWithOffset(date: Date, timezone: string): string {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(date);
	const get = (type: string) => parts.find(p => p.type === type)?.value ?? "00";

	const year = get("year");
	const month = get("month");
	const day = get("day");
	const hour = get("hour") === "24" ? "00" : get("hour");
	const minute = get("minute");
	const second = get("second");

	// Compute UTC offset: build a Date from the local parts in UTC, compare
	const localMs = Date.UTC(
		Number(year), Number(month) - 1, Number(day),
		Number(hour), Number(minute), Number(second),
	);
	const offsetMs = localMs - date.getTime();
	const offsetMin = Math.round(offsetMs / 60_000);
	const sign = offsetMin >= 0 ? "+" : "-";
	const absMin = Math.abs(offsetMin);
	const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
	const offM = String(absMin % 60).padStart(2, "0");

	return `${year}-${month}-${day} ${hour}:${minute}:${second}${sign}${offH}:${offM}`;
}

/** Coerce a YAML frontmatter time value to "HH:MM" or "H:MM AM/PM" string.
 *  YAML parses unquoted "16:39" as sexagesimal number 999. */
export function coerceFmTime(val: unknown): string | undefined {
	if (val == null) return undefined;
	if (typeof val === "number") {
		const h = Math.floor(val / 60);
		const m = val % 60;
		return `${h}:${String(m).padStart(2, "0")}`;
	}
	if (typeof val === "string") return val;
	return undefined;
}

/** Coerce a YAML frontmatter date value to "YYYY-MM-DD" string.
 *  YAML may parse unquoted dates as Date objects. */
export function coerceFmDate(val: unknown): string | undefined {
	if (val == null) return undefined;
	if (val instanceof Date) {
		const y = val.getFullYear();
		const m = String(val.getMonth() + 1).padStart(2, "0");
		const d = String(val.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	if (typeof val === "string") return val;
	return undefined;
}
