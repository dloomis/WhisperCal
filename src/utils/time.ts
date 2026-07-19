/**
 * Get midnight in a given timezone as a UTC Date.
 * Computes the UTC offset at actual midnight (not at the guess time)
 * to handle DST transitions correctly.
 */
/**
 * Midnight (00:00 local) of a `YYYY-MM-DD` calendar date in `timezone`, as a UTC Date.
 * Computes the UTC offset at actual midnight (not at the guess time) to handle DST.
 */
/** UTC offset (ms) of `timezone` at the given instant: local wall-clock minus UTC. */
function tzOffsetMs(instant: Date, timezone: string): number {
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
}

/**
 * Resolve a wall-clock instant "YYYY-MM-DDTHH:MM:SS" (interpreted in `timezone`)
 * to the correct UTC Date, handling DST via a two-pass offset check.
 */
function zonedWallTime(isoLocal: string, timezone: string): Date {
	const guess = new Date(`${isoLocal}Z`); // treat the wall time as UTC first
	const offset1 = tzOffsetMs(guess, timezone);
	const t1 = new Date(guess.getTime() - offset1);
	const offset2 = tzOffsetMs(t1, timezone);
	return offset1 === offset2 ? t1 : new Date(guess.getTime() - offset2);
}

export function midnightFromDateKey(localDate: string, timezone: string): Date {
	return zonedWallTime(`${localDate}T00:00:00`, timezone);
}

/**
 * Get midnight in a given timezone as a UTC Date.
 * Computes the UTC offset at actual midnight (not at the guess time)
 * to handle DST transitions correctly.
 */
function midnightInTimezone(date: Date, timezone: string): Date {
	return midnightFromDateKey(formatDate(date, timezone), timezone);
}

/**
 * Return local-midnight (in `timezone`) of the calendar day that is `offset`
 * days from the day `date` falls on in that zone. Use this instead of
 * `new Date(y, m-1, d + offset)` for day navigation: the latter builds
 * system-local midnight, which drifts by a day whenever the configured
 * timezone differs from the system zone. Calendar arithmetic is done on UTC
 * date parts (tz-independent) before snapping to the zone's midnight.
 */
export function addDaysInTimezone(date: Date, timezone: string, offset: number): Date {
	const [y, m, d] = formatDate(date, timezone).split("-").map(Number);
	const shifted = new Date(Date.UTC(y!, m! - 1, d! + offset));
	const pad = (n: number) => String(n).padStart(2, "0");
	const key = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
	return midnightFromDateKey(key, timezone);
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
 *
 * Adding a fixed 24h to the day's start is wrong on a 25-hour fall-back day: it
 * lands at 23:00 of the SAME calendar day, so midnightInTimezone snaps back to
 * this day's midnight and end === start — the caller then queries Graph with an
 * empty range and caches the day as permanently empty (next occurrence:
 * Nov 1 2026, America/New_York). Instead, normalize to this day's midnight and
 * step 26h forward: since a civil day is at most 25h, 26h always lands strictly
 * inside the next calendar day, and midnightInTimezone snaps that back to
 * next-day midnight correctly on normal, spring-forward, and fall-back days.
 */
export function getDayEndUTC(date: Date, timezone: string): string {
	const start = midnightInTimezone(date, timezone);
	const wellIntoNextDay = new Date(start.getTime() + 26 * 3600_000);
	return midnightInTimezone(wellIntoNextDay, timezone).toISOString();
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
 * Format a time for frontmatter writes. Pinned to a fixed Latin-digit locale —
 * the system locale can emit digits/dayPeriods ("٩:٠٠", "午前9:00") that
 * parseDateTime can never read back. Use formatTime only for display.
 */
export function formatTimeForFrontmatter(date: Date, timezone: string): string {
	const hour12 = resolveHour12();
	return new Intl.DateTimeFormat(hour12 ? "en-US" : "en-GB", {
		timeZone: timezone,
		hour: "numeric",
		minute: "2-digit",
		hour12,
	}).format(date);
}

/**
 * Format a Date as 4-digit 24-hour time (e.g. "1730") in the given timezone.
 * Designed for filenames: collation-friendly, no separator characters.
 */
export function formatTimeHHmm(date: Date, timezone: string): string {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date).replace(":", "");
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
 *
 * `timezone` interprets the wall-clock value in that zone (frontmatter times are
 * written in the configured zone). Omit it only for legacy callers that want
 * system-local parsing — a traveling user with a configured zone would otherwise
 * get a Date offset by hours and "No matching recording found".
 */
export function parseDateTime(dateStr: string, timeStr: string, timezone?: string): Date | null {
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

	if (timezone) {
		const pad = (n: number) => String(n).padStart(2, "0");
		const d = zonedWallTime(`${dateParts[1]}-${dateParts[2]}-${dateParts[3]}T${pad(hour)}:${pad(minute)}:00`, timezone);
		return isNaN(d.getTime()) ? null : d;
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

/** Parse a duration from number (seconds) or string ("MM:SS" / "HH:MM:SS"). */
export function parseDurationSeconds(raw: unknown): number {
	if (typeof raw === "number") return raw;
	if (typeof raw !== "string") return 0;
	const parts = raw.split(":").map(Number);
	if (parts.some(isNaN)) return 0;
	if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
	if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
	return 0;
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
 *  YAML may parse unquoted dates as Date objects.
 *
 *  Read back with UTC getters, not local ones: YAML builds a date-only value as
 *  midnight *UTC*, so local getters roll it to the previous day everywhere west
 *  of Greenwich (`2026-07-15` → "2026-07-14" in America/New_York). Callers
 *  compare the result against a formatDate() day key, so that silently lost the
 *  match. The zone the day is *displayed* in is not this function's business —
 *  it returns the calendar date exactly as authored. */
export function coerceFmDate(val: unknown): string | undefined {
	if (val == null) return undefined;
	if (val instanceof Date) {
		if (isNaN(val.getTime())) return undefined;
		const y = val.getUTCFullYear();
		const m = String(val.getUTCMonth() + 1).padStart(2, "0");
		const d = String(val.getUTCDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	if (typeof val === "string") return val;
	return undefined;
}
