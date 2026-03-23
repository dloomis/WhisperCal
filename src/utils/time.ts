/**
 * Get midnight in a given timezone as a UTC Date.
 * Uses Intl to find the local date parts, then binary-searches for the
 * UTC instant where that timezone shows 00:00 on that calendar day.
 */
function midnightInTimezone(date: Date, timezone: string): Date {
	// Get the calendar date in the target timezone
	const localDate = formatDate(date, timezone); // "YYYY-MM-DD"
	// Start with a rough guess: interpret as UTC midnight, then adjust
	const guess = new Date(`${localDate}T00:00:00Z`);
	// Get the UTC offset at that guess by comparing formatted parts
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(guess);
	const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
	const localH = get("hour") === 24 ? 0 : get("hour");
	const localM = get("minute");
	// The offset in ms: if the timezone shows 19:00 when UTC is 00:00,
	// midnight local is 5 hours after UTC midnight (offset = +5h).
	const shownMs = (localH * 60 + localM) * 60_000;
	// Midnight local = guess - shownMs (if shown > 12h, we wrapped a day)
	const offsetMs = shownMs <= 12 * 3600_000 ? -shownMs : (24 * 3600_000 - shownMs);
	return new Date(guess.getTime() + offsetMs);
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
 */
export function getDayEndUTC(date: Date, timezone: string): string {
	const midnight = midnightInTimezone(date, timezone);
	return new Date(midnight.getTime() + 24 * 3600_000).toISOString();
}

/**
 * Format a Date as a time string (e.g. "9:00 AM") in the given timezone.
 */
export function formatTime(date: Date, timezone: string): string {
	return date.toLocaleTimeString(undefined, {
		timeZone: timezone,
		hour: "numeric",
		minute: "2-digit",
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
	return date.toLocaleDateString("en-US", {
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

	const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
	if (!timeMatch) return null;

	let hour = parseInt(timeMatch[1]!, 10);
	const minute = parseInt(timeMatch[2]!, 10);
	const meridiem = timeMatch[3]!.toUpperCase();

	if (meridiem === "PM" && hour !== 12) hour += 12;
	if (meridiem === "AM" && hour === 12) hour = 0;

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
