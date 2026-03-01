import {setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import type {RecordingManager} from "../services/RecordingManager";
import type {RecordingSession} from "../services/RecordingTypes";
import {formatTime, formatDate} from "../utils/time";

export interface MeetingCardHandle {
	el: HTMLElement;
	destroy: () => void;
}

export function renderMeetingCard(
	container: HTMLElement,
	event: CalendarEvent,
	timezone: string,
	noteCreator: NoteCreator,
	recordingManager: RecordingManager,
	isActive = false,
): MeetingCardHandle {
	const cls = isActive ? "whisper-cal-card whisper-cal-card-active" : "whisper-cal-card";
	const card = container.createDiv({cls});
	const destroyFns: Array<() => void> = [];

	// Subject row: Meeting Name
	const subjectRow = card.createDiv({cls: "whisper-cal-card-subject-row"});
	subjectRow.createDiv({cls: "whisper-cal-card-subject", text: event.subject});

	// Time row
	const timeRow = card.createDiv({cls: "whisper-cal-card-time-row"});
	const timeEl = timeRow.createDiv({cls: "whisper-cal-card-time"});
	if (event.isAllDay) {
		timeEl.setText("All day");
	} else {
		const start = formatTime(event.startTime, timezone);
		const end = formatTime(event.endTime, timezone);
		timeEl.setText(`${start} - ${end}`);
	}

	const session: RecordingSession = {
		eventId: event.id,
		subject: event.subject,
		date: formatDate(event.startTime, timezone),
	};

	// Metadata row: [Teams link] [invitee count] [mic icon]
	const meta = card.createDiv({cls: "whisper-cal-card-meta"});

	if (event.onlineMeetingUrl) {
		const joinUrl = event.onlineMeetingUrl;
		const locLink = meta.createSpan({
			cls: "whisper-cal-card-meta-item whisper-cal-card-meta-link",
			attr: {"aria-label": "Join online meeting"},
		});
		locLink.addEventListener("click", (e) => {
			e.preventDefault();
			window.open(joinUrl);
		});
		const locIcon = locLink.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(locIcon, "map-pin");
		locLink.createSpan({text: event.location || "No location"});
	} else {
		const locEl = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		const locIcon = locEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(locIcon, "map-pin");
		locEl.createSpan({text: event.location || "No location"});
	}

	if (event.attendeeCount > 0) {
		const attEl = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		const attIcon = attEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(attIcon, "users");
		attEl.createSpan({text: String(event.attendeeCount)});
	}

	const micBtn = meta.createEl("button", {
		cls: "whisper-cal-card-rec-trigger clickable-icon",
		attr: {"aria-label": "Record meeting"},
	});
	setIcon(micBtn, "mic");

	const updateMicState = () => {
		const state = recordingManager.getState();
		const isThisSession =
			(state.status === "recording" || state.status === "paused" || state.status === "saving") &&
			state.session.eventId === session.eventId;
		const isBusy =
			(state.status === "recording" || state.status === "paused" || state.status === "saving") &&
			!isThisSession;

		micBtn.removeClass("whisper-cal-card-rec-active");
		micBtn.removeClass("whisper-cal-card-rec-disabled");
		micBtn.removeAttribute("disabled");

		if (isThisSession) {
			micBtn.addClass("whisper-cal-card-rec-active");
			micBtn.setAttribute("disabled", "true");
			micBtn.ariaLabel = "Recording in progress";
		} else if (isBusy) {
			micBtn.addClass("whisper-cal-card-rec-disabled");
			micBtn.setAttribute("disabled", "true");
			micBtn.ariaLabel = "Another recording in progress";
		} else {
			micBtn.ariaLabel = "Record meeting";
		}
	};

	updateMicState();

	micBtn.addEventListener("click", () => {
		const start = async () => {
			// Ensure note exists and is open before recording
			if (noteCreator.noteExists(event)) {
				await noteCreator.openExistingNote(event);
			} else {
				await noteCreator.createNote(event);
			}
			updateButtonState();
			await recordingManager.startRecording(session);
		};
		void start();
	});

	const unsubscribe = recordingManager.onChange(() => updateMicState());
	destroyFns.push(unsubscribe);

	// Actions row
	const btnContainer = card.createDiv({cls: "whisper-cal-card-actions"});

	// Create/open note button
	const btn = btnContainer.createEl("button", {cls: "whisper-cal-btn"});

	const updateButtonState = () => {
		btn.empty();
		if (noteCreator.noteExists(event)) {
			const icon = btn.createSpan({cls: "whisper-cal-card-icon"});
			setIcon(icon, "file-text");
			btn.createSpan({text: "Open note"});
		} else {
			const icon = btn.createSpan({cls: "whisper-cal-card-icon"});
			setIcon(icon, "plus");
			btn.createSpan({text: "Create note"});
		}
	};

	updateButtonState();

	btn.addEventListener("click", () => {
		btn.disabled = true;
		const handleClick = async () => {
			try {
				if (noteCreator.noteExists(event)) {
					await noteCreator.openExistingNote(event);
				} else {
					await noteCreator.createNote(event);
				}
				updateButtonState();
			} finally {
				btn.disabled = false;
			}
		};
		void handleClick();
	});

	return {
		el: card,
		destroy: () => {
			for (const fn of destroyFns) {
				fn();
			}
		},
	};
}
