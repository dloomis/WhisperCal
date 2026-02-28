import type {CalendarProvider} from "../types";
import type {MsalAuth} from "./MsalAuth";
import {GraphApiProvider} from "./GraphApiProvider";

export function createCalendarProvider(auth: MsalAuth): CalendarProvider {
	return new GraphApiProvider(auth);
}
