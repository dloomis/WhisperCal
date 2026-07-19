# WhisperCal holistic code review — 2026-07-19

Reviewed at commit `bd57538` by five parallel reviewers (core/auth/LLM plumbing, recording pipeline, speaker/LLM services, calendar/meeting data, UI). Every finding was verified against the actual code paths — none are speculative. Line numbers are anchors into `bd57538`; re-locate by the described code if the file has drifted.

## Instructions for the executing session

- Work through findings in order (severity-sorted). Each is independent unless noted.
- After each fix, ensure `npm run build` and `npm run lint` pass.
- Conventions: strict null checks, `noUncheckedIndexedAccess`, imperative Obsidian DOM (`createEl`), sentence-case UI strings, `whisper-cal-` CSS prefix. No test suite exists — verify by reasoning through the failure scenario.
- F1 was additionally re-verified by the orchestrating session directly against the source; F2 was independently found by two reviewers. Treat both as high-confidence.
- F14, F15, and F18 are carried forward from CODE_REVIEW_2026-07-15.md (its F8, F7, F15) — they were deliberately skipped in that execution pass and re-verified still present at `bd57538`. Fix them now or consciously re-skip.
- Prior-review fixes verified intact at `bd57538` (do NOT re-fix): 2026-07-15 F1 (legacy LLM key deletion now gated on `coreMigrationDone`), F2 (`CardUiState.resolveKey`), F3 (FolderSelectModal), F4 (parseDateTime tz args), F11 (`addDaysInTimezone` prefetch), F12/F17/F18 (transcript-section-scoped replace, frontmatter queue, legacy library filenames), F27 (celebrations pruning); all F1–F10 from CODE_REVIEW_RECORDING_LOOP_2026-07-17.md.

---

## HIGH

### F1. `applySpeakerTags` body rewrite chains replacements — swapped/chained names corrupt the transcript
- **Where:** `src/services/SpeakerTagApplier.ts:88-113` (chaining loop at 106-111)
- **Bug:** Replacements are applied sequentially over the same `body` string. On a re-tag review (`buildMappingsFromCache` → modal), `originalName` is the current real-name body label, so one decision's `confirmedName` can equal another decision's `originalName`. Swap correction — decisions `[{Dan → Bill}, {Bill → Dan}]`: sort by length gives `[Bill→Dan, Dan→Bill]`; pass 1 turns every `**Bill**` into `**Dan**`, pass 2 turns ALL `**Dan**` (originals plus just-created) into `**Bill**` — every transcript line ends up labeled "Bill" while frontmatter (per-attendee, correct) claims the swap succeeded. Chained variant: `{Speaker 2 → Dan}` + `{Dan → Dan Loomis}` chains Speaker 2's lines through to "Dan Loomis". Silent, unrecoverable body corruption; frontmatter and body permanently disagree.
- **Fix:** Two-pass replace with collision-proof placeholders: map each `from` to a unique sentinel first (`**from**` → `\0WCSPKi\0`, `from |` → sentinel), then map sentinels to targets — the same idiom `MeetingMerger` already uses (`\0WCSPK${i}\0`).

---

## MEDIUM

### F2. Linking an unlinked recording to an event whose note was renamed creates a duplicate note — found by two reviewers
- **Where:** `src/ui/CalendarView.ts:1507-1525` (`handleLinkUnlinked`, `choice.type === "event"` branch); `src/ui/NoteCreator.ts:189-194`
- **Bug:** The candidate filter at `CalendarView.ts:1467-1472` uses `noteCreator.findNote(e)` (frontmatter scan — finds notes at non-canonical paths, e.g. renamed via the card's own "Rename note…"). But the link step calls `createNote(choice.event)` + `getNotePath(choice.event)`; `createNote` only checks the canonical template path. A renamed (or template-drifted) note passes the filter, then a second note is created at the canonical path and the transcript pointer is written into the duplicate. The user's real note stays transcript-less, and two notes now claim the same `calendar_event_id`/date/start, making later `findNote` resolution order-dependent.
- **Fix:** Resolve `findNote`-first: `const existing = this.noteCreator.findNote(choice.event); const notePath = existing?.path ?? …create path…` — or use `ensureNote`-style resolution — before calling `linkToNote`.

### F3. Raw frontmatter reads skip `coerceFmDate`/`coerceFmTime` at four sites — TypeError on legacy unquoted values
- **Where:** `src/main.ts:2140-2151` (`handleLinkRecording`); `src/ui/ModalHeader.ts:23-25, 40-42` (`buildMeetingSubtitle`, called from `main.ts:1254, 1765`); `src/ui/CalendarView.ts:1037, 1045-1046` (`onActiveFileChanged`)
- **Bug:** The codebase documents the trap (`NoteCreator.ts:102-104`): unquoted `meeting_date: 2026-07-19` re-reads as a Date object and `meeting_start: 16:39` as the sexagesimal number 999, and `parseDateTime` calls `.match()` on its arguments. (1) `handleLinkRecording`: `fm["meeting_start"] as string` on a legacy note → `parseDateTime(dateStr, 999, tz)` throws `timeStr.match is not a function`; "Link recording" dies with an unhandled rejection, no Notice. (2) `buildMeetingSubtitle`: same raw casts throw; at `main.ts:1254` the modal queue's try/catch swallows it, silently skipping the speaker-tag modal for that transcript. (3) `onActiveFileChanged`: a Date `meeting_date` is truthy, `!==` string always true, `meetingDate.split("-")` throws on every active-leaf change of the note, killing auto-navigate-to-day and note-open highlight.
- **Fix:** Route all four sites through `coerceFmDate`/`coerceFmTime` (as `CalendarView.ts:923-927` and `NoteCreator.ts:82-84` already do). In `handleLinkRecording`, replace the ad-hoc Date branch at `main.ts:2144-2147` with `coerceFmDate`.

### F4. All-day events parse as SYSTEM-local midnight but format in the CONFIGURED zone — wrong `meeting_date`, ghost duplicate card on the previous day
- **Where:** `src/services/GraphApiProvider.ts:209-210`; `src/services/GoogleCalendarProvider.ts:159-164`; consumed at `src/services/TemplateEngine.ts:17`, `src/ui/NoteCreator.ts:41`, `src/ui/CalendarView.ts:892, 899`
- **Bug:** `parseGraphDate` for all-day events does `new Date(s.slice(0,10) + "T00:00:00")` — system-local midnight (Google identical). Downstream formatters use the configured zone. With system=UTC, configured=America/New_York, an all-day event on day D gets startTime = D 00:00Z = D−1 20:00 NY, so creating a note from the day-D card writes filename prefix "D−1", `meeting_date: "D-1"`, `meeting_start: "8:00 PM"`. `findLocalNotes` for day D−1 then renders a ghost "unscheduled" card (the note's `calendar_event_id` isn't in D−1's calendar set) — the meeting appears on two days with wrong frontmatter. The Graph comment (lines 205-207) fixed UTC-midnight only to *system*-local, not the configured zone.
- **Fix:** Thread `timezone` from `fetchEvents` into `parseGraphEvent`/`parseGoogleEvent` and parse all-day dates with `midnightFromDateKey(s.slice(0,10), timezone)` (already exported from `utils/time.ts`).

### F5. `waitAndLink` rung 3 adopts a pre-existing transcript with no guid and no ctime check — failed re-record silently re-links the OLD transcript and reports success
- **Where:** `src/services/ApiRecording.ts:612-631` (rung 3; expected-path poll at 623-628 has neither the `beforeStop` window nor a guid check); `:448, 455-461` (enrichment overwrites `meeting_note` and keeps the foreign guid with only a console.debug)
- **Bug:** Re-record flow: `startCardApiRecording` resets the note's `transcript`/`pipeline_state` (`MeetingCard.ts:763-767`) but the old transcript file stays at `"{note} - Transcript.md"`. Session S2 records; Tome crashes before writing T2. Per-guid status fails, rung 2's guid scan finds nothing, then rung 3's `expectedPath` poll hits the OLD T1 immediately — unlike `findNewestFile` there is no `ctime > beforeStop` filter, and unlike rung 1 (`:588-597`) no `readTranscriptSessionGuid` verification. T1 is adopted: its metadata overwritten with S2's context, the note re-linked to T1, and the user sees "Transcript linked" — masking that the re-record produced nothing. On a legacy guid-unaware Tome this fires on EVERY re-record (Tome collision-suffixes T2 to `"… (1).md"` while the expected-path poll finds T1 first).
- **Fix:** In rung 3, when `sessionGuid` is known, verify the candidate via `readTranscriptSessionGuid` and reject a differing guid (mirror rung 1); additionally require `stat.ctime > beforeStop` for the expected-path candidate.

### F6. `ApiUnlinkedProvider.linkToNote`: unprotected transcript rename after enrichment — failure leaves a dead-end state
- **Where:** `src/services/ApiUnlinkedProvider.ts:151` (unprotected rename), `:100-136` (enrichment first), `:164-170` (note-side link last); caller catch at `src/ui/CalendarView.ts:1578-1581`
- **Bug:** Step 1 enriches the transcript (writes `meeting_note: [[note]]`, which makes `findUnlinked` skip it forever). Step 2 calls `fileManager.renameFile` with no try/catch and no `retryRename` — the Windows EBUSY/EPERM transient that `retryRename` (`:22-33`) exists for is applied to the audio/sidecar companions but NOT the transcript itself; `renameFile` also throws when a file already exists at `expectedPath` (e.g. an older `"{note} - Transcript.md"` from a re-record). Either failure throws before step 3, so the note never gets `transcript`/`pipeline_state`. Net: transcript invisible in the unlinked list, note unlinked, pill shows Record again — manual frontmatter surgery required.
- **Fix:** Wrap the transcript rename in try/catch + `retryRename`; on failure proceed to step 3 under the original basename (downstream uses `transcriptFile.basename`, nothing requires the conventional name). On collision, fall back to a suffixed target. Alternatively, write the note-side link before attempting the rename.

### F7. `healVoiceprints` compares the raw typed name against the canonical proposal — confirming the same person under a variant falsely "heals" their own library
- **Where:** `src/services/VoiceprintEnroller.ts:405-410` (`confirmed === proposed` on raw strings); small-library bypass at `:428-429`; contrast enroll's `canon()` at `:297-299, 308-311`
- **Bug:** `matchVoiceprints` proposes the canonical library name ("David Smith"). If the user edits the pre-filled name to a variant of the same person ("Dave Smith", which `PeopleMatchService.canonicalName` resolves to "David Smith"), enrollment canonicalizes correctly — but `healVoiceprints` compares raw `confirmed !== proposed` and treats the accepted match as a corrected FALSE match. `removeCulpritSample` then deletes the sample most similar to this speaker's centroid — the one enroll just added (cosine ≈ 1.0). With the library at ≤2 samples the keep-guard doesn't apply; below `HEAL_OUTLIER_MAX 0.55` cross-channel similarity it deletes regardless of size. The heal silently undoes enrollment and can strip a young library.
- **Fix:** Canonicalize `confirmed` through the same `PeopleMatchService` path enroll uses (`canon(confirmed) === proposed` ⇒ skip heal) before treating an override as a false match.

### F8. Malformed LLM JSON entry (missing/non-string `original_name`) throws TypeError, bypassing every graceful-degradation fallback
- **Where:** `src/services/SpeakerTagParser.ts:149-162` (unvalidated entry stored), crash at `:219-221` (`mapping.originalName.toLowerCase()`); reached from `main.ts:1107`, caught only by the generic handler at `main.ts:2014`
- **Bug:** `extractJsonSpeakers` validates `proposed_name`/`confidence`/`evidence` but stores `entry.original_name` verbatim. Output like `{"speakers":[{"index":0,"proposed_name":"Dan"}]}` parses as valid JSON, then `mergeWithFrontmatter` calls `.toLowerCase()` on undefined → TypeError propagates out of `parseSpeakerTagOutput`. The LLM already edited the transcript in place, but the user gets no review modal, no cached proposals, and none of the parser's own fallback paths (`buildFallbackMappings` + warning) fire — just "unexpected error" logged to the note.
- **Fix:** In the entry loop: `const originalName = typeof entry?.original_name === "string" ? entry.original_name : ""; if (!originalName) continue;` (route to the fallback-with-warning branch when every entry is malformed). Also guard `typeof entry.index === "number"`.

### F9. `SpeakerTagModal.createPersonNote` builds the People-note path from the unsanitized (LLM-proposed) name and injects it unescaped into YAML
- **Where:** `src/ui/SpeakerTagModal.ts:520-532` (path at 523, YAML at 532)
- **Bug:** The input is pre-filled with the LLM's `proposedName`; "create note" does `` `${peopleFolderPath}/${name}.md` `` with no `sanitizeFilename`/`normalizePath` and writes `full_name: "${name}"` with no `yamlEscape`. A proposed name containing `/` creates a nested path (create throws, or the note lands outside the People folder; `../X` escapes it entirely). A name containing a double quote produces unparseable frontmatter, so `PeopleMatchService.buildIndex` skips the note (`if (!fm) continue`) — the just-created note is invisible to `canonicalName`, silently breaking the library↔People 1:1 alignment it was created to establish. Every sibling path does this right (`PeopleAutoCreate.ts:129, 213`).
- **Fix:** `const path = normalizePath(\`${folder}/${sanitizeFilename(name)}.md\`)` and `full_name: "${yamlEscape(name)}"`.

### F10. Escape pressed to dismiss the autocomplete dropdown closes the entire SpeakerTagModal, discarding all typed names
- **Where:** `src/ui/SpeakerTagModal.ts:486-489` (Escape branch in the input keydown handler)
- **Bug:** The Escape branch (`showDropdown(false); selectedIdx = -1;`) neither stops propagation nor overrides the modal scope, and Obsidian's Modal registers Escape on its keymap scope — the same keypress also fires `Modal.close()`. User has hand-corrected several of N speakers, presses Escape to dismiss a suggestion list → whole modal closes with `submitted === false` → `prompt()` resolves null → all corrections lost. Directly contradicts the modal's own data-loss protection at `:219-221` (backdrop-click dismissal deliberately blocked).
- **Fix:** In the Escape branch call `e.preventDefault(); e.stopPropagation();`, and register a scope override while a dropdown is visible (`this.scope.register([], "Escape", …)` that hides the dropdown and returns false, else closes) since the scope handler can run before the input's bubble-phase listener.

### F11. `reviewSpeakerCandidates` double-click guard is ineffective — `presentSpeakerTagModal` resolves at enqueue, not when the review settles
- **Where:** `src/main.ts:1247` (queue assignment), `:1550-1579` (guard)
- **Bug:** `presentSpeakerTagModal`'s last statement is `this.speakerTagModalQueue = this.speakerTagModalQueue.then(async () => {…modal…})` — an assignment, never awaited, so the returned promise resolves as soon as the modal is *enqueued* (milliseconds). `reviewSpeakerCandidates`' `.finally(() => this.reviewingSpeakers.delete(key))` clears the guard while the modal is still open. Second click → guard misses → `buildMappingsFromCache` snapshots pre-apply proposals → a second modal is enqueued; after the first modal's apply, the second opens with stale mappings and re-applies old names over fresh tags — the exact scenario the guard's own comment (`:1566-1569`) says it prevents.
- **Fix:** `const run = this.speakerTagModalQueue.then(async () => {…}); this.speakerTagModalQueue = run; return run;` (the internal try/catch keeps the chain unbroken; the `void`-call sites are unaffected). Alternatively move `reviewingSpeakers.delete(key)` inside the queued closure's finally.

### F12. `refreshModels` drops the configured model from the dropdown whenever Core's `listModels` fails — shows "Default" while the stored model still drives jobs
- **Where:** `src/settings.ts:1108-1119` (`refreshModels`), `:1085-1089` (seeding), `:1137-1144` (`fetchAnthropicModels`)
- **Bug:** `addPromptGroup` seeds each dropdown with `["Default", current]` and selects `current`; then `display()` ends with `void this.refreshModels()`, which does `sel.replaceChildren()` and repopulates with `["Default", ...fetched]`. `fetchAnthropicModels` returns `[]` on ANY failure (Core absent, `listModels` absent, no API key, network error) — and then `sel.value = current` has no matching option, so the select shows "Default" while `settings.speakerTagModel` etc. still hold the real model and every job still uses it. Touching the dropdown at all permanently overwrites the stored model. Since a missing key/Core is a common state, this fires on essentially every settings open for affected users.
- **Fix:** After repopulating, if `current` is non-empty and not among fetched ids, re-add it (`sel.add(new Option(current, current))`) before `sel.value = current` — never remove the configured value from its own dropdown. Optionally skip `replaceChildren` when the fetch failed.

### F13. Now-marker treats the "Ad Hoc" placeholder as a timed meeting — meeting-free days show "Nothing left on the calendar — you made it!" at any hour
- **Where:** `src/ui/CalendarView.ts:635-655` (placeholder render), `:667-673` (empty-day early return), `:1754, 1817-1849` (`updateNowMarker`); `src/ui/MeetingCard.ts:558-561` (dataset stamping)
- **Bug:** `renderMeetingCard` stamps `data-start-time`/`data-end-time` on any non-all-day event, including the synthetic `unscheduled` placeholder whose start/end are both the instant the view was opened (always past by the next tick). On an empty day, the 60 s now-line tick finds cards=[placeholder] → `afterLast=true` → appends the end-of-day card "Nothing left on the calendar — you made it!" plus the now dot at 6 AM, directly beside "No meetings today". On days with meetings, the "before the day's first meeting — no marker" branch (`:1820`) is unreachable, so the dot floats between the placeholder and the first meeting instead of hiding.
- **Fix:** Don't stamp `data-start-time`/`data-end-time` on the placeholder (skip when `event.id === "unscheduled"`), or have `updateNowMarker` exclude `data-event-id="unscheduled"` / zero-duration cards.

### F14. (carried from 2026-07-15 F8 — still present) MacWhisper transcription-wait loop survives plugin unload
- **Where:** `src/services/LinkRecording.ts:45-85`
- **Bug:** The fire-and-forget IIFE in `performLink` polls `hasTranscriptLines` (spawning `sqlite3`) every 3 s for up to ~3 min with no stop signal, then calls `createTranscriptFile`, creating a vault file and mutating frontmatter after the plugin is disabled — the bug class `stopApiRecordingWatchers()` fixed on the API path (`ApiRecording.ts:18-27`, wired at `main.ts:465`).
- **Fix:** Mirror the ApiRecording pattern: module-level `linkWatchersStopped` flag with stop/reset exports, checked after each `sleep` and before `createTranscriptFile`; call stop/reset from `onunload`/`onload` alongside the existing API-watcher calls.

### F15. (carried from 2026-07-15 F7 — still present) Existing transcript silently adopted when re-linking a note to a different MacWhisper session
- **Where:** `src/services/TranscriptWriter.ts:200-224`
- **Bug:** `performLink` writes session B's id to the note (`LinkRecording.ts:37`), then `createTranscriptFile` sees `"{note} - Transcript.md"` exists (session A's content), heals backlinks, and returns without comparing `macwhisper_session_id` to `opts.sessionId`. Note claims session B while displaying session A's text; Speakers/Summary run on the wrong content. Also verified: this early-return path sets only `FM.TRANSCRIPT` (`:222`), never `pipeline_state`, unlike the fresh-create path (`:278-281`).
- **Fix:** Compare the existing transcript's `macwhisper_session_id` to `opts.sessionId`; on mismatch regenerate content from the new session or Notice "Transcript exists for a different recording" instead of silently succeeding. Also set `pipeline_state` in the heal path.

---

## LOW

### F16. Manually linking an older transcript overwrites the note's in-flight session guid — the live recording's link tail declares itself "superseded"
- **Where:** `src/services/ApiUnlinkedProvider.ts:163-170` (unconditional guid mirror) vs `src/services/ApiRecording.ts:664-673` (superseded check + `persistence.remove`)
- **Bug:** Note X is recording/transcribing under guid G2. Mid-tail, the user links an old unlinked transcript T1 (guid G1) to X — `linkToNote` mirrors G1 onto the note unconditionally. When G2's `waitAndLink` finishes, `noteGuid (G1) !== sessionGuid (G2)` → the just-recorded session is treated as superseded (it's actually newer), its persisted entry removed (no restart retry), its fresh transcript left unenriched. Recovery is manual-only (`autoLinkBySessionGuid` can't find the note; `findObviousMeeting` excludes linked notes).
- **Fix:** In `linkToNote`, don't overwrite an existing differing `session_guid` when it corresponds to an in-flight session (check `cardUi`/persisted `activeApiRecordings`), or only write the guid when the note has none.

### F17. `mergeMeetings` has no rollback — merged transcript is created before the merged note
- **Where:** `src/services/MeetingMerger.ts:418` (transcript created), `:475` (note created after), `:507-512` (originals marked last)
- **Bug:** The merged transcript is written with `meeting_note` pointing at the not-yet-created note path (`:435`) before `vault.create(mergedNotePath, …)`. If the note create throws, the error propagates to the caller's Notice, leaving a `"…_merged"` transcript with a dangling `meeting_note` (which then surfaces in the unlinked list as a bogus candidate) and unmarked originals — retrying mints `"… - Transcript_merged (1)"`. Same shape if the per-part `merged_into` writes fail midway.
- **Fix:** Create the merged note first (it needs only the pre-computed path), or on note-create failure delete the just-created transcript before rethrowing.

### F18. (carried from 2026-07-15 F15 — still present) Lowercase MacWhisper session IDs silently match zero rows
- **Where:** `src/services/MacWhisperDb.ts:300-306` (`hasTranscriptLines`), `:312-362` (`getTranscript`)
- **Bug:** IDs are interpolated into `WHERE hex(…) = '${sessionId}'`; SQLite `hex()` emits uppercase, `isValidHexId` accepts lowercase (hand-edited/lowercased frontmatter read back via `getLinkedSessionIds`). `hasTranscriptLines` polls false for the full 3-minute window, ending in "Transcription in progress — try again later".
- **Fix:** `sessionId = sessionId.toUpperCase()` at the top of both functions.

### F19. Graph events fetched while the `/me` lookup fails are cached with `isOrganizer:false` forever
- **Where:** `src/services/GraphApiProvider.ts:108-113, 138-140`; cached at `src/services/CalendarCache.ts:116`, replayed at `:105-109`
- **Bug:** If `fetchUserEmail` fails but `calendarView` succeeds, events parse with `userEmail = ""` → `isOrganizer: false` everywhere, and the cache persists that day. The provider retries the email later, but the cached day is never re-parsed; once past, it's served from cache permanently — organizer badge and `PeopleAutoCreate` self-exclusion stay wrong for those events.
- **Fix:** When `userEmail` is still null after the attempt, throw (letting the cached provider fall back to cache rather than caching poisoned data) or mark the result non-cacheable.

### F20. Future days prefetched before the day arrives are trusted as final and never re-fetched
- **Where:** `src/services/CalendarCache.ts:104-109, 209-229`
- **Bug:** `prefetchFutureDays` stamps future days `fetchedAt = now`. If the user doesn't open Obsidian until after those days pass (offline stretch, vacation), `fetchEvents` sees `isPast && pastEntry` and serves the week-old prefetch forever — meetings added/cancelled between prefetch and the day are permanently wrong, even though one live fetch would correct it.
- **Fix:** In the past-day branch, re-fetch when `pastEntry.fetchedAt < end-of-that-day` (via `midnightFromDateKey(nextDayKey, timezone)`) and the upstream is available; fall back to the stale entry offline.

### F21. `meeting_invitees` YAML lines are built without `yamlEscape` — a quote in a resolved name corrupts the whole frontmatter block
- **Where:** `src/services/TemplateEngine.ts:50` (and the `attendees` comma-list at `:48`); injected raw at `src/ui/NoteCreator.ts:296-305`
- **Bug:** Invitees are emitted as `  - "[[${n}]]"` unescaped. An attendee resolving to a People-note basename containing a double quote (legal on macOS) — `Bob "Bobby" Smith` — produces unparseable YAML; metadataCache reports no frontmatter, `findNote` can't match the note (duplicate creation on next click), and pipeline-state machinery ignores it.
- **Fix:** `resolvedNames.map(n => \`  - "[[${yamlEscape(n)}]]"\`)`; same for the attendees list.

### F22. `formatTime` writes `meeting_start` in the system locale — non-Latin locales produce values `parseDateTime` can never read back
- **Where:** `src/utils/time.ts:122-129` (writer), `:192-226` (reader); frontmatter writes via `TemplateEngine.ts:18-19`, `CalendarView.ts:1238-1239, 1521-1522`
- **Bug:** Locale-`undefined` formatting emits Arabic-Indic digits ("٩:٠٠") or CJK dayPeriods ("午前9:00") on affected system locales; the stored value matches neither `parseDateTime` regex → parses null everywhere: `startMatches` degrades to time-agnostic (two same-subject same-day meetings collapse onto one note) and `handleLinkRecording` falls back to file ctime. Narrow population, silent failure.
- **Fix:** Add a `formatTimeForFrontmatter` pinned to a fixed locale (`en-US`/`en-GB` per hour12) for frontmatter-bound writes; keep locale-sensitive `formatTime` for display.

### F23. LLM JSON extraction anchors on the FIRST ` ```json ` fence — a draft block before the final block discards all proposals
- **Where:** `src/services/SpeakerTagParser.ts:113-122`
- **Bug:** `jsonStart = stdout.indexOf("```json")` with `jsonEnd = stdout.lastIndexOf("```")`. A model that emits an intermediate ` ```json ` block (or prose mentioning one) before the final answer makes the slice span both blocks plus intervening prose → JSON.parse fails → degrades to "speakers without AI suggestions", discarding a well-formed final block.
- **Fix:** Use `stdout.lastIndexOf("```json")` for `jsonStart` (optionally falling back to the first on parse failure).

### F24. `confirmed_speakers` wikilinks written from raw typed names, not canonicalized — dangling links and duplicates
- **Where:** `src/services/SpeakerTagApplier.ts:67-76`
- **Bug:** `confirmed.push(\`[[${d.confirmedName}]]\`)` uses the name as typed while enrollment canonicalizes to the People-note basename: typing "Mike Johnson" for note "Michael Johnson" yields library "Michael Johnson" but link `[[Mike Johnson]]` — unresolved. A split diarizer cluster confirmed twice to one person pushes duplicate entries; `|`/`]]`/`#` in a name produces a malformed link.
- **Fix:** Canonicalize via `PeopleMatchService` before building the wikilink (share enroll's `canon()`); dedupe the array.

### F25. People index variant collision can route one person's `canonicalName` (and voiceprints) to another person's note
- **Where:** `src/services/PeopleMatchService.ts:175-177` (frontmatter-less notes skipped), `:210-225` (basename indexed only if key free; nickname variants first-come)
- **Bug:** Note A "Michael Johnson.md" (nickname "Mike") registers variant key "mike johnson". Note B "Mike Johnson.md" — a distinct person with no frontmatter (skipped at `:177`) or no `full_name` — never claims its own basename key if A is iterated first. `canonicalName("Mike Johnson")` returns A, so `enrollVoiceprints` writes B's centroid into "Michael Johnson.json": two people merged into one library, which then CERTAIN-matches either voice to A. Order-dependent, silent voice-identity contamination.
- **Fix:** Index every note's own basename unconditionally and stage basename/`full_name` keys before any nickname/email variants (mirror the `pendingEmailVariants` pattern); index frontmatter-less notes as basename-only PersonInfo.

### F26. `runLlmJob` reads `debugMode` from two different Core snapshots — a mid-window toggle writes wrong pipeline state or skips post-run handling
- **Where:** `src/main.ts:1913` (gate snapshot), `:1991` (post-run check uses snapshot), `:1010-1030, 1654-1667, 1834-1851` (spawnOpts re-fetch `this.coreLlm()` fresh)
- **Bug:** The gate captures `llmConfig` once, but the `spawnOpts` closures re-fetch Core config after two awaits (login-shell `validateLlmCli`, prompt-file `access`). Toggle debug ON in that window → spawn goes to `runLlmTerminal` (resolves immediately, exitCode 0, empty stdout) but stale `debugMode === false` doesn't short-circuit → summarize/research `onSuccess` writes `pipeline_state: summarized` / `research_state: research-done` before the terminal produced anything. Toggle OFF → stale `true` skips `appendLlmErrorSection`/`onSuccess`; for speakerTag that defeats the `preBody` transcript-restore safety net.
- **Fix:** Pass the gate's `llmConfig` (or its `debugMode`/`timeoutMinutes`) into the spawnOpts builders so spawn and post-spawn branch agree; better, have `spawnLlmPrompt` return whether it actually ran in debug mode and branch on that.

### F27. "Enable LLM features" toggle desyncs from settings when clicked while the consent modal is open
- **Where:** `src/settings.ts:946-969`
- **Bug:** While `LlmConsentModal.prompt()` is pending, `handling` is true, but the settings pane stays interactive: a second click flips the toggle's DOM state, then the handler bare-returns at `if (handling)`. Cancel the modal → toggle shows ON while `llmEnabled` is false (or vice versa) until re-render; the next click toggles from the wrong baseline.
- **Fix:** In the re-entrancy guard, snap the toggle back (`toggle.setValue(this.plugin.settings.llmEnabled)`) instead of bare `return`, and/or disable the toggle while the modal is open.

### F28. `microphoneUser` OS probe re-runs on every plugin load while the setting is empty — blocks onload and reverts a deliberate clear
- **Where:** `src/main.ts:617-642`
- **Bug:** The comment says "first install," but the condition is `if (!this.settings.microphoneUser)`, so the probe runs on every `loadSettings` while the field is empty: (1) `onload` awaits it — on a domain-joined Windows machine off the domain network, the PowerShell `UserPrincipal` lookup can hang to its 5 s timeout on every launch; (2) a user who deliberately cleared "Microphone user" (it gates the mic-user auto-tag exemption in `shouldAutoTag`) gets it silently re-populated on next restart — the setting cannot be kept empty.
- **Fix:** Gate on a one-shot persisted marker (e.g. `micUserProbed: true` after the first attempt, or run only when `data === null`), and/or run the probe fire-and-forget after `onLayoutReady` instead of awaiting in `onload`.

### F29. Card status/badge invisible if the note is renamed during the post-capture transcription tail
- **Where:** `src/ui/MeetingCard.ts:768-772` (`onStatus: onStatusForCard(notePath, …)` bound at record start); `src/services/CardUiState.ts:79-85` (`resolveKey` consults only the live recordings map)
- **Bug:** `resolveKey` maps a renamed note to its recording entry only while the recording exists. After capture ends, the entry is deleted (`ApiRecording.ts:269`) but `waitAndLink` keeps issuing statuses ("Transcribing…", "Transcript linked") via the closure bound to the record-start path, potentially for hours. Rename the note in that window (Rename is offered whenever the note exists) → `setStatus(oldPath)` files under the old key while the re-rendered card reads `getStatus(newPath)` → no badge for the rest of the tail. Display-only (linking still succeeds via the live `info.noteFile`; terminal statuses self-clear).
- **Fix:** Have `resolveKey` also consult status-owning sessions, or bind `onStatusForCard` to a live path getter (resolve through `info.noteFile?.path` at write time).

---

## Observations (not bugs — decide, don't just fix)

- **`calendarProvider` has no UI setter.** `settings.ts` only reads it (`:1169`); `rebuildProviderStackIfChanged` fires only via `onExternalSettingsChange`/`saveSettings`. A user cannot switch Microsoft↔Google from WhisperCal's UI. This looks deliberate post-C3 ("managed in WhisperCore"), but the setting still lives in WhisperCal's `data.json` and Core's DTO has no provider-selection member — confirm the intended home for provider choice before/while touching related code.
- **2026-07-17 F11 (Tome orphan-refinalize)** remains the known open question on the Tome side; unchanged and not actionable in this repo.

## Clean areas (verified — no findings; don't spend time re-auditing)

- **CoreBridge / CoreCalendarAuth / whispercore.ts** — API re-fetched per call (never cached across an await), exact version match, boolean-first readiness, error-prefix → AuthError mapping consistent.
- **runCoreHandoff / doCoreHandoff** — in-flight guard set synchronously; keys deleted only after successful `importConfig`; persist-failure self-heals on next restart.
- **LLM concurrency slot accounting** — every exit path in `doTagSpeakers`/`runLlmJob` balanced, including pre-work throws; auto-tagger's check-then-claim is synchronous.
- **LlmInvoker / LlmTransport split** — timers cleared on error and close; `activeProcesses` swept on unload with SIGTERM→SIGKILL; POSIX group kill and Windows taskkill correct; tmp files cleaned on all paths.
- **Plugin lifecycle** — all listeners via `registerEvent` (the one ad-hoc metadataCache listener self-detaches ≤2 s); JobTracker/CardUiState cleared on unload; post-unload timers no-op.
- **RecordingApi.ts** — defensive parsing throughout; guid/startedAt extraction correct.
- **AutoSpeakerTagger** — single-consumer pump, cancellable sleep, listeners terminate and don't double-fire.
- **Pagination** — Graph `@odata.nextLink` and Google `pageToken` loops complete.
- **Gov-cloud hosts** — all Graph URLs derive from `auth.getGraphBaseUrl()`; no hardcoded commercial hosts.
- **utils/vec.ts, llmErrorLog.ts, frontmatter.ts, WordReplacer, VoiceprintMatcher, PeopleAutoCreate, SeriesPrep, nameParser, sanitize, vault.ts, MeetingExporter** — traced clean.
- **All confirmation/input modals** — resolve-once-null-after pattern correct; suggest modals defer past `onChooseSuggestion`; audio player uses `getResourcePath` (no object-URL leaks); CalendarView intervals registered and cleared; render generations abort after view close.
- **DST arithmetic in time.ts** (`zonedWallTime` two-pass, `addDaysInTimezone`, `getDayEndUTC` 26 h step) — verified correct including spring-forward/fall-back days.
