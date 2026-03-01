import {Notice, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {formatTime} from "../utils/time";

export interface MeetingCardHandle {
	el: HTMLElement;
}

export function renderMeetingCard(
	container: HTMLElement,
	event: CalendarEvent,
	timezone: string,
	noteCreator: NoteCreator,
	macWhisperShortcutName: string,
	isActive = false,
): MeetingCardHandle {
	const cls = isActive ? "whisper-cal-card whisper-cal-card-active" : "whisper-cal-card";
	const card = container.createDiv({cls});

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

	// Note icon — create or open note
	const noteBtn = meta.createEl("button", {
		cls: "whisper-cal-card-rec-trigger clickable-icon",
	});

	const updateNoteState = () => {
		if (noteCreator.noteExists(event)) {
			setIcon(noteBtn, "file-text");
			noteBtn.ariaLabel = "Open note";
			noteBtn.removeClass("whisper-cal-card-note-missing");
		} else {
			setIcon(noteBtn, "file-plus");
			noteBtn.ariaLabel = "Create note";
			noteBtn.addClass("whisper-cal-card-note-missing");
		}
	};

	updateNoteState();

	noteBtn.addEventListener("click", () => {
		noteBtn.disabled = true;
		const handleClick = async () => {
			try {
				if (noteCreator.noteExists(event)) {
					await noteCreator.openExistingNote(event);
				} else {
					await noteCreator.createNote(event);
				}
				updateNoteState();
			} finally {
				noteBtn.disabled = false;
			}
		};
		void handleClick();
	});

	// Mic icon — launch MacWhisper via macOS Shortcut
	const micBtn = meta.createEl("button", {
		cls: "whisper-cal-card-rec-trigger clickable-icon",
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		attr: {"aria-label": "Open MacWhisper"},
	});
	setIcon(micBtn, "mic");

	micBtn.addEventListener("click", () => {
		if (macWhisperShortcutName) {
			window.open(`shortcuts://run-shortcut?name=${encodeURIComponent(macWhisperShortcutName)}`);
		} else {
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			new Notice("Configure a MacWhisper shortcut name in WhisperCal settings");
		}
	});

	return {el: card};
}
