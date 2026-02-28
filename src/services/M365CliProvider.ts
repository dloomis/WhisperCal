import {execFile} from "child_process";
import type {CalendarEvent, CalendarProvider, GraphEvent} from "../types";

const EXEC_TIMEOUT_MS = 30_000;

export class M365CliProvider implements CalendarProvider {
	private cliPath: string;

	constructor(cliPath: string) {
		this.cliPath = cliPath;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const output = await this.runCli(["status", "--output", "json"]);
			const status = JSON.parse(output) as { connectedAs?: string };
			return !!status.connectedAs;
		} catch {
			return false;
		}
	}

	async fetchEvents(date: Date): Promise<CalendarEvent[]> {
		const startDateTime = toISODate(date) + "T00:00:00.000Z";
		const endDate = new Date(date);
		endDate.setUTCDate(endDate.getUTCDate() + 1);
		const endDateTime = toISODate(endDate) + "T00:00:00.000Z";

		const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${startDateTime}&endDateTime=${endDateTime}&$orderby=start/dateTime&$select=id,subject,start,end,location,isAllDay,attendees,organizer,isOnlineMeeting,type`;

		const output = await this.runCli(["request", "--url", url, "--output", "json"]);
		const response = JSON.parse(output) as { value?: GraphEvent[] } | GraphEvent[];

		const events = Array.isArray(response) ? response : (response.value ?? []);
		return events.map(parseGraphEvent);
	}

	private runCli(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile(this.cliPath, args, {timeout: EXEC_TIMEOUT_MS}, (error, stdout, stderr) => {
				if (error) {
					const code = (error as { code?: string }).code;
					if (code === "ENOENT") {
						reject(new M365CliError(
							"m365 CLI not found. Install from https://pnp.github.io/cli-microsoft365/",
							"NOT_FOUND"
						));
					} else {
						const message = stderr?.trim()
							? `CLI error: ${stderr.trim().substring(0, 200)}`
							: error.message;
						reject(new M365CliError(message, "CLI_ERROR"));
					}
					return;
				}
				resolve(stdout);
			});
		});
	}
}

export class M365CliError extends Error {
	code: "NOT_FOUND" | "CLI_ERROR" | "NOT_AUTHENTICATED";

	constructor(message: string, code: "NOT_FOUND" | "CLI_ERROR" | "NOT_AUTHENTICATED") {
		super(message);
		this.name = "M365CliError";
		this.code = code;
	}
}

function parseGraphEvent(event: GraphEvent): CalendarEvent {
	const attendees = event.attendees?.map(a => a.emailAddress.name) ?? [];
	return {
		id: event.id,
		subject: event.subject ?? "(No subject)",
		isAllDay: event.isAllDay ?? false,
		isOnlineMeeting: event.isOnlineMeeting ?? false,
		startTime: new Date(event.start.dateTime + "Z"),
		endTime: new Date(event.end.dateTime + "Z"),
		location: event.location?.displayName ?? "",
		attendeeCount: attendees.length,
		attendees,
		organizerName: event.organizer?.emailAddress?.name ?? "",
		organizerEmail: event.organizer?.emailAddress?.address ?? "",
	};
}

function toISODate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
