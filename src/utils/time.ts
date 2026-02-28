/**
 * Get the start of a day in a given timezone as a UTC ISO string.
 * Used to build Graph API calendarView date range params.
 */
export function getDayStartUTC(date: Date, timezone: string): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const localDate = formatter.format(date); // "YYYY-MM-DD"
	return `${localDate}T00:00:00.000Z`;
}

/**
 * Get the end of a day (start of next day) in a given timezone as a UTC ISO string.
 */
export function getDayEndUTC(date: Date, timezone: string): string {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const localDate = formatter.format(date); // "YYYY-MM-DD"
	const nextDay = new Date(`${localDate}T00:00:00Z`);
	nextDay.setUTCDate(nextDay.getUTCDate() + 1);
	const nextFormatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "UTC",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const nextDate = nextFormatter.format(nextDay);
	return `${nextDate}T00:00:00.000Z`;
}

/**
 * Format a Date as a time string (e.g. "9:00 AM") in the given timezone.
 */
export function formatTime(date: Date, timezone: string): string {
	return date.toLocaleTimeString("en-US", {
		timeZone: timezone,
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
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
