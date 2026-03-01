import {App, Notice, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {formatTime, formatDate} from "../utils/time";
import {findRecordingsNear, setSessionTitle} from "../services/MacWhisperDb";
import {RecordingSuggestModal} from "./RecordingSuggestModal";
import {updateFrontmatter} from "../utils/frontmatter";
import type {MacWhisperRecording} from "../services/MacWhisperDb";

export interface MeetingCardHandle {
	el: HTMLElement;
}

export function renderMeetingCard(
	container: HTMLElement,
	event: CalendarEvent,
	timezone: string,
	noteCreator: NoteCreator,
	app: App,
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

	// Mic icon — link MacWhisper recording to note
	const micBtn = meta.createEl("button", {
		cls: "whisper-cal-card-rec-trigger clickable-icon",
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		attr: {"aria-label": "Link MacWhisper recording"},
	});
	setIcon(micBtn, "mic");

	micBtn.addEventListener("click", () => {
		micBtn.disabled = true;
		const handleMic = async () => {
			try {
				await linkRecording(app, event, noteCreator, timezone, micBtn);
			} finally {
				micBtn.disabled = false;
			}
		};
		void handleMic();
	});

	return {el: card};
}

async function linkRecording(
	app: App,
	event: CalendarEvent,
	noteCreator: NoteCreator,
	timezone: string,
	micBtn: HTMLButtonElement,
): Promise<void> {
	if (!noteCreator.noteExists(event)) {
		new Notice("Create a note first");
		return;
	}

	const recordings = findRecordingsNear(event.startTime);

	if (recordings.length === 0) {
		new Notice("No matching recording found");
		return;
	}

	let selected: MacWhisperRecording | null;
	if (recordings.length === 1) {
		selected = recordings[0]!;
	} else {
		const modal = new RecordingSuggestModal(app, recordings);
		selected = await modal.prompt();
	}

	if (!selected) return;

	// Set title in MacWhisper DB: "YYYY-MM-DD Subject"
	const date = formatDate(event.startTime, timezone);
	const title = `${date} ${event.subject}`;
	setSessionTitle(selected.sessionId, title);

	// Write session ID to note frontmatter
	const notePath = noteCreator.getNotePath(event);
	await updateFrontmatter(app, notePath, "macwhisper_session_id", selected.sessionId);

	// Update icon to show linked state
	setIcon(micBtn, "check");
	// eslint-disable-next-line obsidianmd/ui/sentence-case
	micBtn.ariaLabel = "MacWhisper recording linked";

	new Notice("Recording linked to note");
}
