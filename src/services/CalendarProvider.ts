import type {CalendarProvider} from "../types";
import {M365CliProvider} from "./M365CliProvider";

export function createCalendarProvider(m365CliPath: string): CalendarProvider {
	return new M365CliProvider(m365CliPath);
}
