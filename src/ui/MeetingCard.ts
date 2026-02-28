import {setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {formatTime} from "../utils/time";

export function renderMeetingCard(
	container: HTMLElement,
	event: CalendarEvent,
	timezone: string,
	noteCreator: NoteCreator,
): HTMLElement {
	const card = container.createDiv({cls: "whisper-cal-card"});

	// Time range
	const timeEl = card.createDiv({cls: "whisper-cal-card-time"});
	if (event.isAllDay) {
		timeEl.setText("All day");
	} else {
		const start = formatTime(event.startTime, timezone);
		const end = formatTime(event.endTime, timezone);
		timeEl.setText(`${start} - ${end}`);
	}

	// Subject
	card.createDiv({cls: "whisper-cal-card-subject", text: event.subject});

	// Metadata row
	const meta = card.createDiv({cls: "whisper-cal-card-meta"});

	if (event.location) {
		const locEl = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		const locIcon = locEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(locIcon, "map-pin");
		locEl.createSpan({text: event.location});
	}

	if (event.attendeeCount > 0) {
		const attEl = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		const attIcon = attEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(attIcon, "users");
		attEl.createSpan({text: String(event.attendeeCount)});
	}

	if (event.isOnlineMeeting) {
		const onlineEl = meta.createSpan({cls: "whisper-cal-card-meta-item"});
		const onlineIcon = onlineEl.createSpan({cls: "whisper-cal-card-icon"});
		setIcon(onlineIcon, "video");
		onlineEl.createSpan({text: "Online"});
	}

	// Create note button
	const btnContainer = card.createDiv({cls: "whisper-cal-card-actions"});
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

	return card;
}
