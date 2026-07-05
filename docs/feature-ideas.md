# WhisperCal feature ideas

A backlog of candidate features and improvements, drawn from comparable tools (Granola, Fathom, Fireflies, Otter, Circleback, Fellow, tl;dv) and gaps in the current workflow. Items marked **(improve)** build on an existing feature; the rest are new. Compiled 2026-07-03.

## Capture & recording

1. **Auto-start/stop recording from calendar** — when a meeting with attendees begins and Tome is healthy, start recording automatically (with a "recording started" notice + one-click cancel); auto-stop at meeting end plus a grace period. Granola/Fathom-style "never forget to record."
2. **Pre-meeting nudge** — Obsidian notice ~2 min before a meeting: one click to create the note and start recording.
3. **Live elapsed/recording HUD (improve)** — the status API already reports `startedAt`; show a live elapsed timer on the card and a status-bar item while recording, with a stop button.
4. **Mid-meeting flag/highlight hotkey** — a command you hit during the meeting that timestamps a "flag"; flagged moments get emphasized in the summary and listed as highlights.
5. **No-show / skip state** — for past meetings with no matching recording, a one-click "didn't happen / no notes needed" state so cards stop looking like unfinished pipeline work.

## Intelligence on top of transcripts

6. **Action-item extraction to real tasks** — a pipeline step (or part of summarize) that emits `- [ ]` checkboxes with assignee and due date in Tasks-plugin-compatible format, plus a command for an aggregated "open action items across meetings" note. The single most-copied feature across Fathom/Fireflies/Circleback.
7. **Decision log** — extract explicit decisions into a `decisions` frontmatter list or section, and optionally append to a global rolling "Decisions" note with backlinks.
8. **Follow-up email/recap draft** — generate a ready-to-send recap addressed to the attendees (copy to clipboard or `mailto:`), from the summary + action items.
9. **Ask-your-meetings Q&A** — a command that takes a question, gathers relevant transcripts/summaries (by person, series, or date range), and runs one LLM call to answer with links. Otter's "AskFred" equivalent, vault-native.
10. **Topic chapters** — segment long transcripts into titled chapters with timestamps, inserted as headings so the outline pane becomes meeting navigation.
11. **Per-series / per-category summary prompts (improve)** — let a series note or event category override the summarizer prompt, so 1:1s, standups, and client calls each get the right summary shape.
12. **Regenerate with instructions (improve)** — "Re-summarize…" menu item that prompts for a one-line steer ("focus on the pricing discussion") appended to the prompt.
13. **Entity wikilinking** — after summarizing, auto-link mentions of known People notes (and optionally project notes) in the summary, with a confirmation diff.

## Recurring meetings & people

14. **Series rolling memory (improve)** — extend SeriesPrep to feed the last N summaries' open action items and decisions into the Research/prep output, and maintain a "carried over / still open" section in the series note.
15. **1:1 mode** — for 2-person recurring meetings: a per-person running topics list ("bring up next time"), carried-over items, and private-notes section. Fellow-style.
16. **People-note meeting timeline (improve)** — append a dated one-line entry (meeting link + tl;dr) to each attendee's People note after summarizing, giving a "history with this person" view for free.
17. **Voiceprint health panel (improve)** — settings-tab view of each library: sample count, centroid spread/drift, last enrollment, "weak — confirm this person by ear next time" flags.

## Review & navigation

18. **Transcript audio player with timestamp sync** — embed the recording in the transcript note; clicking a line's timestamp seeks playback. Clip extraction for tagging means the audio path already exists.
19. **Weekly digest command** — generates a note rolling up the week: meetings held, total meeting hours, decisions, open action items, people met. Good Monday-review artifact.
20. **Calendar view filter/search (improve)** — filter the sidebar by attendee, keyword, or category; quick jump-to-date.
21. **Talk-time analytics** — per-speaker talk share and longest-monologue stats written to transcript frontmatter and a small bar in the modal/summary; cheap to compute from the tagged transcript, no LLM needed.
22. **Daily-note integration** — insert/refresh a "Today's meetings" block (links + statuses) in the daily note.

## Pipeline & polish

23. **Jobs panel (improve)** — a small view over JobTracker: running/queued/failed LLM jobs with retry and cancel, instead of state living only in pill spinners.
24. **Vocabulary auto-learning (improve)** — auto-suggest replacement entries from attendee/People names and from corrections accepted in the word-replacement modal, so recurring misspellings stop recurring.
25. **Meeting-invite context in prep (improve)** — include the invite body and agenda links in the Research prompt input; organizers often paste the agenda there and it's currently unused signal.
