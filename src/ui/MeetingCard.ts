import {App, TFile, setIcon} from "obsidian";
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
	recordingWindowMinutes = 10,
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
	} else if (event.id === "unscheduled") {
		// Top-level unscheduled card — no time yet
		timeEl.setText("Ad hoc");
	} else if (event.startTime.getTime() === event.endTime.getTime()) {
		// Same start/end (e.g. unscheduled note with only a start time)
		const start = formatTime(event.startTime, timezone);
		timeEl.setText(start);
	} else {
		const start = formatTime(event.startTime, timezone);
		const end = formatTime(event.endTime, timezone);
		timeEl.setText(`${start} - ${end}`);
	}

	// Metadata row: location + invitee count
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

	// Actions row: note + mic icons
	const actions = card.createDiv({cls: "whisper-cal-card-actions"});

	// Mic button ref — hoisted so note click handler can add/check the dot
	let micBtn: HTMLButtonElement | undefined;

	// Note icon — create or open note
	const noteBtn = actions.createEl("button", {
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
				// Show red dot on mic if note now exists but recording not linked
				if (micBtn && !micBtn.disabled && noteCreator.noteExists(event)
					&& !micBtn.querySelector(".whisper-cal-rec-dot")) {
					micBtn.createSpan({cls: "whisper-cal-rec-dot"});
				}
			} finally {
				noteBtn.disabled = false;
			}
		};
		void handleClick();
	});

	// Mic icon — link MacWhisper recording to note
	// Hidden on the top-level unscheduled card (no meeting to match)
	if (event.id !== "unscheduled") {
		const btn = micBtn = actions.createEl("button", {
			cls: "whisper-cal-card-rec-trigger clickable-icon",
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			attr: {"aria-label": "Link MacWhisper recording"},
		});

		// Restore linked state from frontmatter on re-render
		const notePath = noteCreator.getNotePath(event);
		const noteFile = app.vault.getAbstractFileByPath(notePath);
		const alreadyLinked = noteFile instanceof TFile &&
			!!app.metadataCache.getFileCache(noteFile)?.frontmatter?.["macwhisper_session_id"];
		if (alreadyLinked) {
			setIcon(btn, "check");
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			btn.ariaLabel = "MacWhisper recording linked";
			btn.disabled = true;
		} else {
			setIcon(btn, "mic");
			// Red dot if note exists but recording not yet linked
			if (noteCreator.noteExists(event)) {
				btn.createSpan({cls: "whisper-cal-rec-dot"});
			}
		}

		btn.addEventListener("click", () => {
			btn.disabled = true;
			const handleMic = async () => {
				let linked = false;
				try {
					const notePath = noteCreator.getNotePath(event);
					if (!(app.vault.getAbstractFileByPath(notePath) instanceof TFile)) {
						await noteCreator.createNote(event);
						updateNoteState();
					}
					const isUnscheduled = event.id.startsWith("unscheduled");
					linked = await linkRecording({
						app,
						meetingStart: event.startTime,
						notePath,
						subject: event.subject,
						timezone,
						transcriptFolderPath,
						attendees: event.attendees,
						windowMinutes: isUnscheduled ? 720 : recordingWindowMinutes,
					});
					if (linked) {
						setIcon(btn, "check");
						// eslint-disable-next-line obsidianmd/ui/sentence-case
						btn.ariaLabel = "MacWhisper recording linked";
					}
				} finally {
					if (!linked) btn.disabled = false;
				}
			};
			void handleMic();
		});
	}

	return {el: card};
}
