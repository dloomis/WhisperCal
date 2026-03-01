import {App, MarkdownView, Notice, TFile, setIcon} from "obsidian";
import type {CalendarEvent} from "../types";
import type {NoteCreator} from "./NoteCreator";
import {formatTime} from "../utils/time";
import {linkRecording} from "../services/LinkRecording";

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
	transcriptFolderPath = "Transcripts",
	onNoteCreated?: () => void,
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
	} else if (event.startTime.getTime() === event.endTime.getTime()) {
		// Unscheduled card before note creation — no meaningful time
		timeEl.setText("Ad hoc");
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
			window.open(joinUrl, "_blank", "noopener");
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
					const isUnscheduled = event.id === "unscheduled";
					await noteCreator.createNote(event);
					if (isUnscheduled && onNoteCreated) {
						onNoteCreated();
					}
				}
				updateNoteState();
			} finally {
				noteBtn.disabled = false;
			}
		};
		void handleClick();
	});

	// Mic icon — link MacWhisper recording to note
	// Hidden on the top-level unscheduled card (no meeting to match)
	if (event.id !== "unscheduled") {
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
					// Use computed path if the note exists, otherwise fall back
					// to the most recent editor file (handles renamed notes).
					let notePath = noteCreator.getNotePath(event);
					if (!(app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
						const leaf = app.workspace.getMostRecentLeaf();
						const file = leaf?.view instanceof MarkdownView
							? leaf.view.file
							: null;
						if (file) {
							notePath = file.path;
						} else {
							new Notice("Open the meeting note first, then link the recording");
							return;
						}
					}
					const isUnscheduled = event.id.startsWith("unscheduled");
					const linked = await linkRecording({
						app,
						meetingStart: event.startTime,
						notePath,
						subject: event.subject,
						timezone,
						transcriptFolderPath,
						attendees: event.attendees,
						windowMinutes: isUnscheduled ? 720 : undefined,
					});
					if (linked) {
						setIcon(micBtn, "check");
						// eslint-disable-next-line obsidianmd/ui/sentence-case
						micBtn.ariaLabel = "MacWhisper recording linked";
					}
				} finally {
					micBtn.disabled = false;
				}
			};
			void handleMic();
		});
	}

	return {el: card};
}
