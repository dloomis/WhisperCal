# WhisperCal holistic code review — 2026-07-15

Reviewed at commit `81ea717` by four parallel reviewers (core/auth, pipeline services, calendar/meeting data, UI). Every finding below was verified against the actual code paths — none are speculative. Line numbers are approximate anchors; re-locate by the described code if the file has drifted.

## Instructions for the executing session

- Work through findings in order (severity-sorted). Each is independent unless noted.
- After each fix, ensure `npm run build` and `npm run lint` pass.
- Conventions: strict null checks, `noUncheckedIndexedAccess`, imperative Obsidian DOM (`createEl`), sentence-case UI strings, `whisper-cal-` CSS prefix. No test suite exists — verify by reasoning through the failure scenario.
- F2 was independently confirmed by two reviewers; treat as high-confidence.

---

## HIGH

### F1. Legacy LLM keys destroyed before WhisperCore hand-off can migrate them
- **Where:** `src/main.ts:520-526` (with `:571` and `:698-708`)
- **Bug:** `loadSettings` unconditionally deletes legacy LLM keys (`anthropicApiKey`, `llmCli`, `llmExtraFlags`) from `this.settings`. If WhisperCore isn't installed yet, `runCoreHandoff` no-ops (`coreMigrationDone` stays false), but any `persistData()` — including the `microphoneUser` auto-populate at `main.ts:571`, which runs inside the same `loadSettings` call — rewrites `data.json` without those keys. When Core is later installed, the hand-off finds nothing to migrate: Anthropic API key / CLI config permanently lost. Contradicts the comment at `main.ts:700-703` ("LLM keys … intentionally retained here until C4").
- **Fix:** Guard the delete loop with `if (this.settings.coreMigrationDone)`, or move the deletion into `runCoreHandoff`'s success path alongside `AUTH_KEYS` (after a successful `importConfig`).

### F2. Note renamed mid-recording strands the recording entry (CardUiState key asymmetry) — found by two reviewers
- **Where:** `src/services/CardUiState.ts:62-92`, `src/services/ApiRecording.ts:118-121`, `src/ui/MeetingCard.ts:1155-1158`
- **Bug:** The recordings map is keyed by the note path at recording start (`ApiRecording.ts:91`). Only `hasRecording` falls back to matching `info.noteFile.path`; `getRecording`/`deleteRecording` (and the startTime/status/duration-timer accessors) don't. Rename a note mid-recording, then click Stop (the card shows Stop because `hasRecording` matches via the live TFile): (a) `getRecording(newPath)` is undefined so an auto-launched Teams/Zoom is never closed and `waitAndLink` runs with no meeting metadata (transcript loses subject/attendees); (b) `deleteRecording(newPath)` no-ops, leaving `recordingCount ≥ 1` and every card's record pill locked; (c) the stale entry survives until the 2 s watch loop sees the service idle and calls `waitAndLink` a second time with the real info — two concurrent link attempts on the same transcript; (d) `renderCardDynamic:1134` re-seeds `setStartTime(newPath, Date.now())`, resetting the visible elapsed timer.
- **Fix:** Add a private `resolveKey(notePath)` in `CardUiState` that returns the map key whose entry's `info.noteFile?.path === notePath` (falling back to `notePath`), and route `getRecording`, `deleteRecording`, `hasRecording`, `getStartTime`/`setStartTime`/`deleteStartTime`, `getStatus`/`setStatus`/`deleteStatus`, and the duration-timer methods through it.

### F3. `FolderSelectModal.pick()` always resolves null — folder choice discarded
- **Where:** `src/ui/FolderSelectModal.ts:30-45`; consumer `src/settings.ts:288`
- **Bug:** Obsidian's `SuggestModal.selectSuggestion` calls `close()` (synchronously firing `onClose`) *before* `onChooseItem`. `onClose` sees `picked === false` and resolves `null`; the later `resolvePick(item)` hits an already-resolved promise. The settings "Browse" button therefore never applies the picked folder. (`EventSuggestModal` and `RecordingSuggestModal` already defer with `setTimeout` for exactly this ordering — this modal missed it.)
- **Fix:** In `onClose`, wrap the cancel-resolution in `setTimeout(..., 0)` guarded on `this.picked` (match `EventSuggestModal.onClose`); in `onChooseItem`, null out `this.resolvePick` after resolving so the deferred cancel can't double-fire.

### F4. `NoteCreator.findNote` round-trips frontmatter times without the configured timezone → duplicate meeting notes
- **Where:** `src/ui/NoteCreator.ts:64`; same bug family at `src/services/MeetingMerger.ts:64`, `src/ui/ModalHeader.ts:37-38`, `src/ui/CalendarView.ts:870,878,1317`
- **Bug:** `meeting_start` is written with `formatTime(event.startTime, settings.timezone)` (`TemplateEngine.ts:18`) but parsed back with `parseDateTime(fmDate, fmTime)` — system-local, the exact trap `parseDateTime`'s docstring (`src/utils/time.ts:189`) warns about. When configured tz ≠ system tz, `startMatches` fails against the note's own event, `findNote` returns null, and `ensureNote` mints a duplicate note.
- **Fix:** Pass `this.settings.timezone` as the third arg to `parseDateTime` at `NoteCreator.ts:64`; audit and fix the sibling call sites listed above (MeetingMerger's affects "Part N — <time>" headings and merged `meeting_start`/`meeting_end` rendering).

### F5. Google attendees lose per-attendee RSVP status
- **Where:** `src/services/GoogleCalendarProvider.ts:146-149`
- **Bug:** The attendee map produces only `{name, email}` even though the API returns `responseStatus` and `mapResponseStatus` already exists in the file. `MeetingCard.ts:353-371` builds accepted/tentative/declined counts from `a.responseStatus`, so Google users always see 0/0/0 with empty tooltips.
- **Fix:** Add `responseStatus: mapResponseStatus(a.responseStatus)` to the attendee map.

---

## MEDIUM

### F6. LLM error log insertion is fence-unaware — corrupts the meeting note on the second error
- **Where:** `src/utils/llmErrorLog.ts:96-101`
- **Bug:** `insertErrorEntry` scans for the next `^#{1,2} ` heading to bound the `## LLM Errors` section, but a previous error entry's fenced CLI output often contains `#`-prefixed lines; the scan matches inside the fence and the new entry is spliced into the middle of the old fenced block, breaking the fence and spilling raw CLI output into the note body.
- **Fix:** Track fence state while scanning (toggle on `/^\s*(`{3,}|~{3,})/`) and only treat `^#{1,2} ` as a boundary when not inside a fence.

### F7. Existing transcript silently adopted when re-linking to a different MacWhisper session
- **Where:** `src/services/TranscriptWriter.ts:200-224`
- **Bug:** Re-link a note to session B when a transcript for session A already exists (session B isn't excluded by the picker — only linked sessions are). `performLink` writes session B's id to the note, but `createTranscriptFile` sees the path exists, heals backlinks, and returns — session B is never transcribed. The note claims session B while displaying session A's text; Speakers/Summary run on the wrong content.
- **Fix:** When the transcript exists, compare its frontmatter `macwhisper_session_id` to `opts.sessionId`; on mismatch either regenerate the transcript content from the new session or show a Notice ("Transcript exists for a different recording — delete it to relink") instead of silently succeeding.

### F8. MacWhisper transcription-wait loop keeps running after plugin unload
- **Where:** `src/services/LinkRecording.ts:45-85`; contrast `src/services/ApiRecording.ts:21-24`; unload at `src/main.ts:418`
- **Bug:** The fire-and-forget poll loop (spawning `sqlite3` every 3 s for up to ~3 min) has no stop signal. Disable/reload the plugin mid-wait and it keeps polling, then creates vault files and mutates frontmatter after unload — the exact bug class `stopApiRecordingWatchers()` fixed on the API path.
- **Fix:** Mirror the ApiRecording pattern: module-level `linkWatchersStopped` flag with stop/reset exports, checked after each `sleep` in `performLink`; call the stop from `onunload` alongside `stopApiRecordingWatchers()`.

### F9. One transient `/me` failure permanently poisons `userEmail` for the session
- **Where:** `src/services/GraphApiProvider.ts:180-183` (and `:164-167`); same pattern `src/services/GoogleCalendarProvider.ts:138-141`
- **Bug:** On error the catch sets `this.userEmail = ""` (and category colors to empty); the `=== null` guard means it's never retried. Until reload: `isOrganizer` is false on every event (wrong "not accepted" badges), category colors missing, and `PeopleAutoCreate`'s self-skip fails — the plugin can auto-create a People note for the user themself.
- **Fix:** On error leave the field `null` so the next `fetchEvents` retries (optionally cap retries).

### F10. Meeting-bundle import is non-atomic with no rollback
- **Where:** `src/services/MeetingImporter.ts:228-267`
- **Bug:** If a `create` fails partway (e.g. transcript create throws after note + audio landed), the already-written files remain: a note whose `transcript` link points at a file that never arrived, plus possibly an orphaned `.m4a`. The `written` array is collected but never used.
- **Fix:** In the catch block, best-effort delete each path in `written` (`getAbstractFileByPath` → `app.vault.delete`) before showing the failure notice.

### F11. Prefetch does day arithmetic in the system zone
- **Where:** `src/services/CalendarCache.ts:213`
- **Bug:** `new Date(y, m, d + i)` builds system-local midnight; when the configured tz is west of the system tz, `toDateKey(futureDate, timezone)` renders the *previous* day, so the prefetch window covers today..today+N−1 and never prefetches the last configured future day. `src/utils/time.ts:52-58` documents this drift and provides the helper.
- **Fix:** `const futureDate = addDaysInTimezone(new Date(), timezone, i)`.

### F12. `SpeakerTagApplier` pipe-format replacement rewrites unrelated body text
- **Where:** `src/services/SpeakerTagApplier.ts:107-109`
- **Bug:** `body.split("John |").join("John Smith |")` is applied to the entire body, so a re-tag rename also fires on markdown table cells or summary text containing `John |`, silently corrupting non-transcript content.
- **Fix:** Restrict replacements to the transcript section (reuse `transcriptBody()`'s heading search for `## Transcript` / `## Full Transcript` and apply from there down), or anchor the pipe format to line starts with a line-wise pass.

### F13. Word-replacements toolbar action never removed on unload
- **Where:** `src/main.ts:388-402`; `onunload` at `:412-437`
- **Bug:** `view.addAction` isn't lifecycle-managed by Obsidian; after disabling/updating the plugin every visited markdown view keeps a dead toolbar icon that invokes `doWordReplacements` on the unloaded plugin instance.
- **Fix:** In `onunload`, iterate `getLeavesOfType("markdown")` and `remove()` all `.whisper-cal-word-replace-action` elements (and for symmetry, any lingering `.whisper-cal-llm-banner` elements).

---

## LOW

### F14. One transient Tome `/status` failure abandons an active recording watch
- **Where:** `src/services/ApiRecording.ts:183-188`
- **Bug:** A single failed 2 s poll deletes the recording state and calls `onStopped()` without ever calling `waitAndLink` — the finished transcript never links, and WhisperCal shows stopped while the service still records.
- **Fix:** Tolerate ~3 consecutive failures before giving up, and on giving up fall through to `waitAndLink` like the stop path does.

### F15. Lowercase MacWhisper session IDs silently match zero rows
- **Where:** `src/services/MacWhisperDb.ts:300-361`
- **Bug:** IDs are compared against SQLite `hex()` output (uppercase); a lowercase ID passes `isValidHexId` but never matches — `hasTranscriptLines` polls for 3 minutes then reports "in progress" with no hint.
- **Fix:** `sessionId = sessionId.toUpperCase()` at the top of `hasTranscriptLines` and `getTranscript`.

### F16. LLM spawn assumes POSIX syntax under the user's login shell
- **Where:** `src/services/LlmInvoker.ts:361-362, 408-409`
- **Bug:** The command uses heredocs and POSIX quoting but runs under `os.userInfo().shell`; a fish or tcsh login shell breaks every LLM job with an opaque syntax error (`validateLlmCli`'s `command -v` also fails under tcsh).
- **Fix:** Keep sourcing PATH from the login shell but execute under a known POSIX shell, e.g. `spawn(userShell, ["-li", "-c", `exec /bin/zsh -c ${shellQuote(cmd)}`])`, or detect fish/tcsh and fall back to `/bin/zsh -li -c`.

### F17. Naive frontmatter split in two services misclassifies content
- **Where:** `src/services/SpeakerTagApplier.ts:99`, `src/services/WordReplacer.ts:143`
- **Bug:** Both scan for the first `\n---` without checking `content.startsWith("---")`: a file with no frontmatter but a `---` horizontal rule gets the text above it treated as frontmatter (excluded from replacements / speaker renames); a file whose closing `---` is the last line (no trailing newline) makes the whole pass silently no-op.
- **Fix:** Gate on `content.startsWith("---")` and treat `bodyStart === -1` as "empty body", matching the already-correct logic in `src/utils/transcript.ts` (`transcriptBody`).

### F18. Voiceprint heal path misses legacy-named libraries
- **Where:** `src/services/VoiceprintEnroller.ts:401-402`; enroll fallback at `:316-320`
- **Bug:** `removeCulpritSample` probes only the current sanitized filename; a library living at a pre-hardening legacy path (kept alive by the enroll fallback) never heals, so the poisoned sample keeps causing the same false match.
- **Fix:** Replicate the enroll fallback: if no library at the sanitized path, probe `${folder}/${legacyFilename(name)}.json`.

### F19. Merge links use bare `[[basename]]`
- **Where:** `src/services/MeetingMerger.ts:372,426,472,482`
- **Bug:** If another vault note shares a basename, `merged_into`/`merged_from`/transcript backlinks can resolve to the wrong file.
- **Fix:** Use `app.fileManager.generateMarkdownLink` (or full paths) for these wikilinks.

### F20. People-note paths not normalized
- **Where:** `src/services/PeopleAutoCreate.ts:130,205`
- **Bug:** A `peopleFolderPath` with a trailing slash yields `Folder//Name.md`; the existence check misses and `vault.create` throws — uncaught in `autoCreatePeopleNotes`'s loop, aborting remaining organizers.
- **Fix:** Wrap both path constructions in `normalizePath`.

### F21. `noteFilenameTemplate` tokens replaced only once
- **Where:** `src/ui/NoteCreator.ts:24-26`
- **Bug:** `String.replace` with a string pattern substitutes only the first occurrence of each `{{date}}`/`{{time}}`/`{{subject}}` token.
- **Fix:** Use `replaceAll`.

### F22. `runCoreHandoff` re-entrancy + partially uncovered try/catch
- **Where:** `src/main.ts:177-187`
- **Bug:** The onload call and the `whispercore:ready` handler can both pass the `coreMigrationDone` check while the first is awaiting `loadData`; also only `importConfig` is inside the try/catch, so a `persistData` disk error escapes the `void`ed promise as an unhandled rejection.
- **Fix:** Add an in-flight boolean guard (set/clear in try/finally) and widen the try to cover the whole body after the `coreMigrationDone` check.

### F23. Throwing auth-state listener blocks subsequent listeners
- **Where:** `src/main.ts:627-631`
- **Fix:** Wrap each `listener(state)` in try/catch with `console.error`.

### F24. Unload cache flush discards rejections
- **Where:** `src/main.ts:426`
- **Fix:** `void this.cachedProvider?.flush().catch(e => console.warn("[WhisperCal] cache flush on unload failed", e));`

### F25. `SpeakerTagModal.seekingForSnippet` can latch true
- **Where:** `src/ui/SpeakerTagModal.ts:139-145, 239-242`
- **Bug:** If seeking to the current position produces no `seeked` event, the flag stays true and the next manual scrubber seek is misclassified as a snippet seek, so playback still auto-pauses at the stale `stopAt`.
- **Fix:** In `playSnippet`, skip/clear the flag when `Math.abs(audioEl.currentTime - start) < 0.01`, or reset it in the `timeupdate` handler once playback is running.

### F26. In-flight `refresh()` continues after view close; `renderError` leaves stale card refs
- **Where:** `src/ui/CalendarView.ts:285-303, 305-410, 494-501`
- **Bug:** `onClose` doesn't null `contentContainer` or bump the generation counters, so a slow fetch completes and re-renders into detached DOM (including firing `autoCreatePeopleNotes`); `renderError`/`renderLoading` don't clear `this.cards`, so recording ticks re-render detached cards.
- **Fix:** In `onClose`, null `contentContainer` and increment `refreshGeneration`/`unlinkedGeneration`; clear `this.cards` (and `mergeSelection`) at the top of `renderError` and `renderLoading`.

### F27. `celebrations` map grows unboundedly
- **Where:** `src/ui/MeetingCard.ts:157`
- **Bug:** One entry per note path ever rendered, never pruned. Slow leak only.
- **Fix:** Evict expired entries (both `railUntil`/`segUntil` past) during render, or clear paths absent from the current card set in `CalendarView.renderEvents`.

---

## Cleanups (non-bugs, optional)

### C1. Dead code: `JobTracker.activeCount`
`src/services/JobTracker.ts:31-34` — no callers; the doc comment ("used by concurrency caps") is false (capping uses `WhisperCalPlugin.activeLlmCount`). Delete or fix the comment.

### C2. Stale CLAUDE.md documentation
CLAUDE.md still describes `src/state.ts` (module-level `summarizeJobs`/`speakerTagJobs` Sets); that file no longer exists — replaced by `JobTracker` + `CardUiState` injected via `CalendarViewCallbacks`. Update the paragraph.

### C3. Modal boilerplate duplication
Ten modals hand-roll identical `resolve`/`submitted`/`prompt()`/deferred-`onClose` boilerplate (~25 lines each). An abstract `PromptModal<T>` base (resolve-once guard + deferred cancel resolution) would delete ~200 lines and make F3-style ordering bugs structurally impossible. `NameInputModal`/`MergeConfirmModal` also duplicate the input+Enter+buttons block nearly verbatim.

### C4. `findNote` date comparison fragility
`NoteCreator.ts:79,88` compares `meeting_date` with `===`; a hand-edited note with an unquoted YAML date re-reads as a `Date` object and silently orphans its card. A `coerceFmDate` on both sides of the comparison hardens this cheaply.

---

## Areas verified clean (don't re-investigate)

- **CoreBridge/CoreCalendarAuth:** WhisperCore contract fully honored — API re-fetched per call, never cached across awaits, exact version match, gate semantics correct.
- **LLM injection surface:** flags/model/CLI quoted per token; randomized heredoc delimiter (POSIX) / temp file (Windows); no injection path from meeting content, settings, or prompts. AppleScript strings escaped.
- **Process cleanup:** `activeProcesses` + `killProcessTree` wired into unload and timeouts; temp files cleaned.
- **LLM concurrency accounting** (`activeLlmCount` claim/release, `preClaimed` hand-off, `AutoSpeakerTagger` pump): balanced on all exit paths.
- **Frontmatter write queue** (`utils/frontmatter.ts` per-file enqueue) defuses the transcript-link vs. state-mirror race; `TranscriptWriter` handles the check-then-create race.
- **time.ts core:** DST two-pass offset resolution, 26-hour day-end, hour-24 normalization, YAML coercions all correct.
- **Graph/Google pagination**, `MeetingRenamer`, `MeetingDeleter`, `MeetingExporter`, `sanitize.ts` (Windows reserved names), `nameParser.ts`, `meetingLink.ts` (gov-cloud hosts), `SeriesPrep.ts`, `vec.ts`: clean.
- **UI:** no `innerHTML` anywhere; modal resolve-once discipline correct everywhere except F3; card re-render listener discipline correct; `CalendarView.onClose` unsubscribes listeners/timers.
- **settings.ts:** debounced save flushed in `hide()`, `execFile` with array args, migrations idempotent (except F1).

---

# Execution report — 2026-07-15

Executed against commit `81ea717`. Scope: **every finding except the MacWhisper ones** (F7, F8, F15 skipped by instruction — not attempted, still open). F1–F6, F9–F14, F16–F27 fixed, plus cleanup C1. C2 required **no change**: CLAUDE.md at `81ea717` already describes `JobTracker`/`CardUiState` injected via `CalendarViewCallbacks` and nowhere mentions `src/state.ts` — the finding itself was stale. C3 (modal base class) and C4 (`coerceFmDate` on both sides) not done — optional refactors, no behavior change, deliberately left.

`npm run build` passes. `npm run lint` exits with **one pre-existing error** — see "Left alone" below.

## Fixes that deviated from the suggested approach

The review's suggested fix was wrong or incomplete in four places. Each is worth knowing before someone "corrects" the code back.

### F27 — the suggested eviction would have silently disabled the feature
The first suggestion ("evict expired entries during render") is **unsafe**. A `CelebrationState` holds `prevDone`, which is the *only* thing that makes the next stage flip detectable. Entries sit outside their animation window nearly all the time, so eviction-on-expiry would drop the state of essentially every card on every render; the re-seed path (`else` branch) sets `prevDone = done`, so no stage would ever be seen to flip and **no card would ever celebrate again**. Took the second suggestion instead: `pruneCelebrations(livePaths)` exported from `MeetingCard`, called from `CalendarView.renderEvents` via `pruneCelebrationState()`, which scans the DOM (not `this.cards`) so the unlinked section's cards — rendered on their own async cycle and not tracked in `cards` — keep their state.

### F19 — full-path links break bundle import; the importer had to change too
Switching merge links to full paths regresses the export→import flow, which the review didn't account for. `MeetingExporter` archives note/transcript **verbatim**, and its own comment says the flat archive layout exists so "wiki links resolve by basename". `MeetingImporter` only rewrote `transcript:`/`meeting_note:` when a name collision forced a rename — otherwise it kept the sender's links, relying on them being bare basenames that resolve anywhere in the receiving vault. A merged note carrying `[[Transcripts/Foo|Foo]]` would dangle in a vault whose transcript folder is named differently.

Fixed by making `MeetingImporter` restate both links **unconditionally** (it should have been self-sufficient regardless; on a non-renamed import the rewrite reproduces the values the bundle already carried, so this only ever narrows a sender-vault path back to a basename). The now-unused `renamed` flag is gone.

Also: used hand-built `[[path|alias]]` rather than `fileManager.generateMarkdownLink` as the review suggested. `generateMarkdownLink` emits **markdown-style** links when the vault is configured that way, which `stripWikiLink` (`/^\[\[/…/\]\]$/`) can't parse — it would break every reader of these fields. All consumers were checked: they use `resolveWikiLink` (alias-tolerant) or test presence only, so the format change is safe.

### F16 — the suggested `exec` trick doesn't work for tcsh
`spawn(userShell, ["-li", "-c", "exec /bin/zsh -c …"])` works for fish but not tcsh: `-l` doesn't combine with `-c` there, so the login shell can't be used to source PATH at all. Split by shell in `posixShellArgs()`: POSIX shells unchanged; fish execs zsh under `-l -c` (keeping `config.fish`'s PATH); tcsh/csh fall back to `/bin/zsh -li -c` and accept the system PATH.

### F21 — `replaceAll` doesn't compile at this project's target
`tsconfig.json` targets ES2018 (`lib: [DOM, ES2018]`); `replaceAll` is ES2021 and fails type-check. Used the `split`/`join` idiom already established in `SpeakerTagApplier`/`MeetingMerger` rather than bumping the project-wide lib target for one call site.

## Fixes that grew beyond the finding

- **F1** — guarded the delete loop on `coreMigrationDone` *and* moved the LLM-key deletion into `runCoreHandoff`'s success path (both options the review offered; together they close the window where a hand-off marks itself done but leaves the keys in `data.json` until the next reload). Extracted `LEGACY_LLM_KEYS`. The stale "retained until C4" doc comment on `runCoreHandoff` is now corrected — `coreLlm()`/`getLlmConfig()` is already the read path, so C4's premise had landed but the comment hadn't caught up.
- **F17** — `bodyStartOffset` landed in **`utils/frontmatter.ts`**, not `utils/transcript.ts` where the reference implementation lives. It's a frontmatter concern, and `WordReplacer` importing "transcript utils" to split YAML would be a smell. `transcript.ts` imports it; `transcriptBody` is now a one-liner over `transcriptStartOffset`, so the three call sites can't drift.
- **F12** — the transcript-section restriction (the review's primary option) subsumes F17's frontmatter gate for `SpeakerTagApplier`, so that file gets the narrower fix only.
- **F20** — also wrapped the organizer loop's `vault.create` in try/catch. `normalizePath` fixes the trailing-slash trigger, but the review's own failure description ("uncaught … aborting remaining organizers") stays true for any other write failure; `createPeopleNotesForNames` already had this guard.
- **F10** — used `fileManager.trashFile`, not `vault.delete` (the finding's suggested API): the ESLint plugin flags `Vault.delete()`, and `VoiceprintEnroller.trashLibrary` already establishes the idiom. (F14 itself followed the suggested fix as written: tolerate consecutive `/status` failures, then fall through to `waitAndLink`.)
- **F26** — folded the existing card/merge teardown in `renderEvents` into the new `discardCards()` so the three paths can't diverge. Note this means a **foreground** refresh now clears an in-progress merge selection; background refresh is unaffected (it skips `renderLoading`, and the auto-refresh tick already bails when `mergeSelection.size > 0`).

## Verification

No test suite exists, so the two riskiest **pure-logic** changes were exercised directly (scratch harness, not committed):

- **F6** — reproduced the exact failure against the pre-fix implementation: a second error entry is spliced *into the middle* of the first entry's fenced CLI output, breaking the fence and spilling raw output into the note body. Confirmed the fence-aware scan places it after the close, while still bounding on a real `## Summary` H2 and respecting `~~~` fences and longer backtick runs.
- **F12/F17** — confirmed a `| John | said things |` summary table survives a re-tag of `John` → `John Smith` (while both transcript label formats are renamed); a `---` horizontal rule in a note with no frontmatter is no longer treated as a frontmatter close; a closing `---` on the final line no longer no-ops the pass; and the `transcriptBody` refactor is behavior-identical across all four framing cases.

Everything else was verified by reasoning through the stated failure scenario plus the type-checker. **Not verified by running the plugin** — no Obsidian round-trip was performed. The UI lifecycle fixes (F13, F25, F26, F27) and the shell fix (F16, no fish/tcsh machine to hand) are the ones most deserving of a manual pass.

## Left alone (deliberate)

- **`src/settings.ts:1231`** — `obsidianmd/ui/sentence-case` error on the "Managed in WhisperCore" `setDesc`. **Pre-existing and unrelated to this review**: `git diff HEAD -- src/settings.ts` is empty. Its sibling `setName`/`setButtonText` calls already carry `// eslint-disable-next-line … -- product name`; this one wants the same. Not touched because it's outside the review's scope — but `npm run lint` is not green until it's addressed.
- **F2 status/start-time key asymmetry after the recording ends.** `resolveKey` now routes `getStatus`/`getStartTime`/timers through the recordings map, which fixes the mid-recording window. Once `deleteRecording` runs, a renamed note's *later* statuses (the transcribe→link tail, which `waitAndLink` still keys by the original path) miss again. Not a regression — they missed before this change too — and out of F2's scope, but it means a note renamed mid-recording still won't show its "Transcribing" badge. Fixing properly means threading the live `TFile` through `waitAndLink` instead of a path string.

## Incidental discoveries

- **`src/services/MeetingMerger.ts` contains four literal NUL bytes** (offsets 5802/5812/5980/5990). **Deliberate, not corruption** — they're the sentinel delimiters in the speaker-rename two-pass replace (`` `\0WCSPK${i}\0` ``), chosen precisely because they can't occur in note text. Consequence: `file` reports the source as `data`, **`grep` silently matches nothing in it**, and `git diff` treats it as binary (use `git diff --text`). This cost real time during execution and will mislead anyone who greps for a symbol here and concludes it's absent. If the sentinel were changed to a printable improbable token (e.g. `␞`), the file would behave like text again.
- **F5's root cause is one-directional.** `GoogleCalendarProvider` already called `mapResponseStatus` for the *self* attendee (driving the user's own RSVP badge), which is why the bug looked invisible from the organizer's side — only the per-attendee counts were empty.
- **F9's `categoryColors` catch had the same latch as `userEmail`** and is fixed the same way (back to `null`, not an empty `Map`), which the finding noted parenthetically but didn't spell out as a separate fix.
