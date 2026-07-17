# Code review — record → receive-transcript loop (Tome/API source)

**Date:** 2026-07-17
**Scope:** The critical capability loop only: recording start (manual Record pill, auto-record-on-join, re-record), the watch loop, stop → wait → link tail, restart reconciliation, the stale-lock reconciler, and the unlinked auto-link safety net. Cross-checked against `SESSION_GUID_DESIGN.md`. MacWhisper flow and downstream pipeline stages (speakers/summary) are out of scope.
**Files reviewed:** `src/services/ApiRecording.ts`, `src/services/RecordingApi.ts`, `src/services/ApiUnlinkedProvider.ts`, `src/services/CardUiState.ts`, `src/ui/MeetingCard.ts`, `src/ui/CalendarView.ts` (recording-related sections), `src/main.ts` (persistence/reconcile wiring), `src/ui/RecordingUnavailableModal.ts`.

**Status: EXECUTED 2026-07-17.** F1–F10 fixed; F11 remains an open question pending the Tome-side answer (manual test 7); doc-drift items applied to `SESSION_GUID_DESIGN.md` and the rung-3 comment/derivation.

---

## F1 — `reconcileRecordingLock` can race the watch loop and silently drop the link tail

**✅ Fixed:** `reconcileRecordingLock` now verifies per-guid status before pruning (a genuinely recording session keeps its entry) and hands every pruned entry to the link tail via `runApiLinkTail` (deduped by `linkingInProgress`).

**Severity: High** (silent transcript-link loss; delayed self-heal)
**Where:** `src/ui/CalendarView.ts:434-466` (`reconcileRecordingLock`), `src/services/ApiRecording.ts:218` (watch-loop entry guard)

Every calendar refresh calls `reconcileRecordingLock()`, which prunes `cardUi` recording entries whenever Tome's global `/status` reports anything other than `"recording"` (with a 10 s startup grace). But the watch loop's first act after each 2 s sleep is `if (!cardUi.hasRecording(notePath)) return;` — a **silent** exit that never runs `waitAndLink`.

**Failure scenario:** User stops the recording from Tome's own UI (or Tome restarts). Global state flips to `"transcribing"`/`"idle"`. If a refresh (auto-refresh tick, manual refresh, settings change) lands in the ≤2 s gap before the watch loop's next poll, the reconciler deletes the entry; the watch loop wakes, sees no entry, and exits without ever handing off to `waitAndLink`. The transcript lands on disk **unlinked**. Recovery only happens later via the unlinked auto-link pass or the next Obsidian restart (persisted-entry reconcile) — and for a guid-unacknowledged legacy session, only via the fuzzy `findObviousMeeting` heuristics.

**Fix direction:** The reconciler cannot distinguish a leaked entry from a healthy one sitting in its poll gap. Options (pick one):
- When pruning, run the same tail as the watch loop's non-recording branch: capture `info`, delete, then `void waitAndLink(...)` (the `linkingInProgress` guard already dedupes against a live watch loop that gets there first).
- Or: only prune entries older than the watch cadence *and* verify via per-guid status (`recordingSessionStatus`) that the session is genuinely not recording before deleting — and still hand off to `waitAndLink` for `transcribing`/`complete`.

---

## F2 — Auto-record on rejoin: spurious "already recording" modal for the meeting's own session

**✅ Fixed:** `attemptAutoRecord` returns early when `cardUi.hasRecording(notePath)` — the meeting is already being captured.

**Severity: Medium** (UX; undermines trust in the auto-record path)
**Where:** `src/ui/MeetingCard.ts:720-731` (`attemptAutoRecord`), `src/ui/MeetingCard.ts:41-54` (`confirmIfServiceRecording`)

`attemptAutoRecord` fires on every join-link click when `automateMeeting` is on, with no check of `cardUi.hasRecording(notePath)`. Rejoining a meeting that WhisperCal is *already recording* (Teams dropped, user re-clicks the link) runs `confirmIfServiceRecording`, which sees state `"recording"` and pops `ActiveRecordingNoticeModal` — telling the user to stop the recording of the very meeting they are rejoining before starting "a new one".

**Fix direction:** In `attemptAutoRecord` (or at the top of `startCardApiRecording`), if `cardUi.hasRecording(notePath)` is already true, return without starting or prompting — the meeting is already being captured, which is exactly the state auto-record wants. Optionally compare the global `/status`'s `recording.sessionGuid` (the design added it precisely for this) against our own session before deciding the mic is "busy with someone else".

---

## F3 — Auto-record silently re-records a meeting that already has a linked transcript

**✅ Fixed:** `attemptAutoRecord` stands down when `hasLinkedTranscript()` — auto-record never silently re-records a linked meeting.

**Severity: Medium** (bypasses the confirmation every manual path requires; orphans the old transcript)
**Where:** `src/ui/MeetingCard.ts:720-731` (`attemptAutoRecord`) vs. `src/ui/MeetingCard.ts:943-964` (menu Re-record gated behind `ReRecordConfirmModal`) and `src/ui/MeetingCard.ts:1236-1277` (Record button's orphan-transcript confirm)

Every manual start path gates re-recording behind `ReRecordConfirmModal`. Auto-record does not: clicking the join link on a card whose transcript is already linked starts a fresh session with `resetFrontmatter=false`. When it finishes, `waitAndLink` overwrites the note's `transcript` link with the new (collision-suffixed) transcript. The old transcript still carries a resolving `meeting_note` backlink, so `findUnlinked` treats it as linked — it never resurfaces anywhere; effectively silent replacement of the note's transcript pointer.

**Fix direction:** In `attemptAutoRecord`, when `hasLinkedTranscript(app, notePath)` (already exported from `ApiRecording.ts`), either skip auto-record entirely or surface the same `ReRecordConfirmModal` before starting. Skipping is probably right: the user rejoining a recorded meeting more likely wants the meeting app open than a second transcript.

---

## F4 — 5-minute transcription-wait cap is too short for long meetings, even when the service reports healthy progress

**✅ Fixed:** the per-guid wait loop resets its stall counter while the service reports "transcribing", with a 2 h absolute backstop; the hard cap now only fires on states showing no progress.

**Severity: Medium** (misleading failure warning; enrichment quality degrades on the recovery path)
**Where:** `src/services/ApiRecording.ts:285-286` (`POLL_INTERVAL_MS`/`MAX_POLL_ATTEMPTS`), `473-527` (both wait loops)

`waitAndLink` polls for completion at 3 s × 100 ≈ 5 minutes, then gives up with "Transcript not ready — check recording service". On-device transcription of a long meeting can plausibly exceed 5 minutes. In the per-guid path this is doubly wrong: the loop *knows* the state is still `"transcribing"` — i.e. the service is working normally — and warns anyway. The persisted entry survives (good), but the automatic link then only happens at the next Obsidian restart or via `autoLinkBySessionGuid`, which produces poorer frontmatter (see F6) and a confusing "Auto-linked 1 transcript" notice long after the scary warning.

**Fix direction:** In the per-guid loop, make the bound state-aware: while `state === "transcribing"`, keep polling (or reset the attempt counter), and reserve the hard cap for states that show no progress. Optionally lengthen the legacy loop's cap too, or scale it with recording duration (known from `startedAt`).

---

## F5 — Rapid re-record while the prior session is still linking: per-note `linkingInProgress` guard permanently orphans the newer transcript

**✅ Fixed:** `linkingInProgress` is keyed by session guid (note path only for legacy sessions), and the link tail refuses to overwrite a note whose `session_guid` was superseded by a newer session — the stale transcript is left unenriched for the unlinked flow.

**Severity: Medium** (permanent orphan requiring manual link; wrong transcript left on the note)
**Where:** `src/services/ApiRecording.ts:14, 457-460` (guard), `714-719` (reconcile "already linked" drop)

The `linkingInProgress` guard is keyed by note path, not session. Sequence: session A stops and enters its link tail (which can run minutes, per F4). User re-records the same note (session B — allowed once A leaves `"recording"`), then stops B while A's tail is still in flight. B's `waitAndLink` returns at the guard immediately and **never retries**. A's tail then links transcript A to the note — even though the note's `session_guid` is already B (latest session). B's persisted entry survives, but on the next reload `reconcileOne` sees the note already has a `transcript` link (A's) and drops B's entry as "already linked". B's transcript never auto-links: `autoLinkBySessionGuid` also refuses because the note is linked. It sits in the unlinked list awaiting a manual decision, while the note points at the stale A transcript.

**Fix direction:** Key the guard by session guid rather than note path, and let the *latest* session win the note's `transcript` pointer (compare the note's current `session_guid` before writing, mirroring the "note tracks the latest session" rule). At minimum, make a guard-blocked call re-queue instead of silently returning.

---

## F6 — `autoLinkBySessionGuid` links with degraded meeting context

**✅ Fixed:** `autoLinkBySessionGuid` now reads `meeting_subject`/`meeting_date`/`meeting_start`/`meeting_end`/`meeting_organizer`/`meeting_location`/`is_recurring` off the note frontmatter and passes them to `linkToNote`.

**Severity: Low-Medium** (data quality on the loop's main safety net)
**Where:** `src/ui/CalendarView.ts:1244-1271`

The guid-based auto-link — the designated recovery path for every crash/timeout case above — calls `linkToNote` with only `subject` (derived by regexing the note basename) and timezone. No attendees, no `meetingDate`/`meetingStart`/`meetingEnd`, no organizer/location, and `is_recurring` defaults to `false` in `ApiUnlinkedProvider.linkToNote`. Invitees survive only if the note's own frontmatter has them. So a transcript recovered by guid gets measurably worse frontmatter than one linked by the live tail — and the transcript is supposed to be "self-contained for LLM use".

**Fix direction:** Before calling `linkToNote`, try to resolve the calendar event (the same `findObviousMeeting` machinery, or match by the note's `meeting_date`/times frontmatter) and pass the full context when found; fall back to the current minimal call otherwise. Alternatively read `meeting_date`/`meeting_start`/etc. straight off the meeting note's frontmatter, which `NoteCreator` already wrote.

---

## F7 — Stop button can kill a different session's live capture (global `/stop` has no identity check)

**✅ Fixed:** `recordingStatus` now parses `sessionGuid` from `/status`; `stopApiRecording` skips the global `/stop` when the live capture belongs to a different session (still runs its own link tail).

**Severity: Low** (narrow window, but destructive when hit)
**Where:** `src/ui/MeetingCard.ts:1202-1223` (stop handler), `src/services/ApiRecording.ts:168-191` (`stopApiRecording`)

`stopApiRecording` posts the global `/stop`. If meeting A's capture ended app-side and a new capture (B) started — both within the watch loop's ≤2 s poll gap — card A still shows Stop; clicking it stops B's live recording. The design added `recording.sessionGuid` to the global `/status` payload precisely so callers can identify *whose* capture is live, but nothing consumes it.

**Fix direction:** In `stopApiRecording`, read `/status` first; if it reports a `sessionGuid` that differs from `info.sessionGuid`, skip the `/stop` POST (still proceed to the link tail for our own session). Requires plumbing `recording.sessionGuid` through `recordingStatus`'s parser in `RecordingApi.ts` (currently dropped).

---

## F8 — Stop path uses the render-time base-URL snapshot; a missing snapshot makes Stop a silent no-op

**✅ Fixed:** the stop handler re-resolves the base URL live and always calls `stopApiRecording` (empty-URL calls tolerate unreachability; the guid disk-scan recovers the transcript), so the click always clears recording state.

**Severity: Low**
**Where:** `src/ui/MeetingCard.ts:1213-1215`

Two related weaknesses in the stop handler:
1. It uses `recordingApiBaseUrl` (snapshot from card render) instead of the live `resolveRecordingApiBaseUrl` re-resolver that `startCapture` deliberately uses because "Tome's API port changes on each launch". A Tome relaunched mid-recording gets the stop POST on a dead port, and `waitAndLink` polls the dead port too (it recovers via the guid disk-scan, but slower and noisier).
2. If the snapshot is `undefined` (port file vanished before this render), the click calls nothing — the `cardUi` entry survives, the card re-renders back to Stop with the elapsed timer reset to 0, and the recording state only clears ~6 s later when the watch loop concedes. The user's click appears to do nothing.

**Fix direction:** `const baseUrl = opts.resolveRecordingApiBaseUrl?.() || recordingApiBaseUrl;` in the stop handler; when even that is falsy, still call `stopApiRecording` with the last-known URL (its catch already tolerates unreachable) or at minimum delete the recording entry and kick `waitAndLink` so the UI honestly reflects the stop.

---

## F9 — Post-enrichment verification can false-alarm on metadata-cache lag

**✅ Fixed:** post-enrichment verification reads the raw frontmatter off disk (`readRawFrontmatterValue`) instead of the lag-prone metadata cache.

**Severity: Low** (spurious error log + "enrichment incomplete" warning)
**Where:** `src/services/ApiRecording.ts:642-649`

After a successful `processFrontMatter` enrichment, the code sleeps 500 ms and checks `metadataCache` for `meeting_note`; if absent it declares "enrichment silently dropped the write". The transcript was written by Tome outside Obsidian moments earlier — on a large vault or slow disk the cache can easily lag more than 500 ms, producing a false "enrichment incomplete" badge for a link that is actually fine.

**Fix direction:** Verify via `vault.adapter.read`/`readRawSessionGuid`-style raw frontmatter parse (authoritative, no cache dependency), or retry the cache check a few times before declaring failure.

---

## F10 — Legacy reconcile can't find a collision-suffixed transcript (rung-3 `beforeStop` anchor)

**✅ Fixed:** `waitAndLink` accepts a `sinceMs` anchor; reconcile passes the persisted `startedAtIso`, so rung 3 can find collision-suffixed transcripts written while Obsidian was closed. Rung 3 also now derives the expected path from `info.suggestedFilename` directly.

**Severity: Low** (legacy-Tome sessions only)
**Where:** `src/services/ApiRecording.ts:462, 570-587`

Rung 3's `findNewestFile` only accepts files with `ctime > beforeStop`, where `beforeStop = Date.now()` **at `waitAndLink` entry**. For a reconciled session (transcript written while Obsidian was closed), every candidate predates `beforeStop`, so any transcript not sitting at the exact expected path (e.g. Tome collision-suffixed it to `… - Transcript 2.md`) is unfindable; the entry retries identically each load until the 24 h abandon. Only affects `guidAcknowledged=false` sessions.

**Fix direction:** When `waitAndLink` is invoked from reconcile, anchor the window to the persisted `startedAtIso` instead of `Date.now()`.

---

## F11 — Open question / must-test: crash-time guid scan may link a partial live transcript

**⏳ Open:** unchanged — needs Tome-side verification of orphan-refinalize behavior (manual test 7).

**Severity: Unknown — needs the Tome-side answer** (maps to manual test 7 in SESSION_GUID_DESIGN.md)
**Where:** `src/services/ApiRecording.ts:559-564` (rung 2), design doc "Artifacts" section

Per the design, Tome's live logger writes the transcript (with `session_guid`) from session *start*. If Tome crashes mid-recording, the watch loop concedes after ~6 s and `waitAndLink`'s rung-2 guid scan will find and link the **partial** live transcript. When Tome relaunches and refinalizes the orphan: if it rewrites the same file in place, fine; if it renames or writes a new file, the note's `[[basename]]` link is now stale or pointing at the unfinalized version. Verify Tome's orphan-refinalize behavior and, if it renames, delay rung-2 adoption of a file whose session state is unknown (e.g. require mtime quiescence) or re-run the ladder when the refinalized file appears.

---

## Design-doc drift (documentation only)

- `SESSION_GUID_DESIGN.md` §7 says persisted entries are removed "on user-visible give-up"; the implementation deliberately keeps them on the not-ready timeout and not-found paths so a restart can retry (better than the doc — update the doc).
- §7's "module-level `Set<string>` of reconciled guids" guard was not implemented. Currently harmless (reconcile runs once at load, before user-started sessions can share a guid), but note it if reconcile is ever re-run mid-session.
- The rung-3 comment at `ApiRecording.ts:566-569` claims the expected path "derives from the ORIGINAL notePath even if the note was renamed" — untrue when `waitAndLink` is invoked from the stop handler of a renamed card (the caller passes the *current* path). Behavior still recovers via the `suggestedFilename` prefix fallback; fix the comment (or derive from `info.suggestedFilename` directly, which is the actual invariant).

---

## What looked solid (no action)

- The §6 match ladder is implemented faithfully: per-guid status → guid disk scan (cache + bounded raw read) → legacy heuristics, with the guid-mismatch guard on rung 1 and no upward falls.
- The stop-button ↔ watch-loop race is correctly closed in both directions (state deleted before the first await; re-check after each status await; `linkingInProgress` dedupe).
- Defensive API parsing throughout `RecordingApi.ts` (2xx-unparseable tolerance, unknown states degrading to safe values, 404→"unknown" distinct from network errors).
- Persistence lifecycle (add on start, remove on link/terminal-failure/note-gone, 24 h abandon with notice) matches the design, and reconcile works fully offline via the guid disk scan.
- Unload hygiene: `watchersStopped`, persistence detach, `cardUi.clear()` — the fire-and-forget tails can't write the vault after unload.
