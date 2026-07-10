# Code review fixes — pre-release hardening plan

**Created:** 2026-07-10, from a six-dimension multi-agent review (Windows/platform, Obsidian directory compliance, security, core services, UI layer, uncommitted-diff review) of the full codebase at 0.8.6 + the uncommitted Windows-support working tree.

**Goal:** get WhisperCal in shape for Obsidian community-directory submission and for advertising Windows support.

**Baseline state (verified during review):** `npm run build` and `npm run lint` both pass with zero warnings. Release 0.8.6 assets are correct. manifest/package/versions.json agree at 0.8.6.

---

## How to execute this plan

- Work in the batches defined under "Execution order & post-batch protocol" at the end of this document; items within a batch are independent unless noted.
- After every batch, run the post-batch protocol (build + lint + commit) before starting the next batch — do not let batches accumulate uncommitted.
- Windows-branch changes (`Platform.isWin` / `process.platform === "win32"` code paths) must leave macOS behavior byte-identical — most fixes below are inside Windows-only branches already.
- Check off items as completed. If a fix turns out to be wrong or the finding doesn't reproduce on inspection, note that inline rather than silently skipping.
- Line numbers are from the 2026-07-10 working tree and may drift slightly; the file + function context is authoritative.
- Deploy for manual testing: copy `main.js`, `manifest.json`, `styles.css` to `~/SDA/.obsidian/plugins/whisper-cal/` and reload Obsidian.

---

## Tier 0 — Decisions needed from Dan (do NOT implement without confirmation)

> **DECIDED 2026-07-10 (Batch A done):** D1 = keep PolyForm NC, state restriction prominently in README (done: top-of-README callout + existing License section). D2 = keep `--dangerously-skip-permissions` default, document only (done: README "LLM trust boundary" Disclosures bullet + strengthened Additional-flags settings warning). No default flag change.

### D1. License: PolyForm Noncommercial vs OSI
`LICENSE:1` is PolyForm Noncommercial 1.0.0. Community-directory reviewers routinely push back on non-OSI licenses, and NC terms technically prohibit the plugin's core audience (work meetings). Options: switch to MIT/Apache-2.0 before the submission PR, or keep PolyForm and be prepared to justify it in the PR + state the restriction prominently in the README. **Decision required.**

### D2. Default `llmExtraFlags` = `--dangerously-skip-permissions`
`src/settings.ts:140` defaults to skipping the LLM CLI's permission checks, while the prompt/trigger content includes third-party-controlled text (transcribed audio, calendar attendee names, invite subjects). A prompt injection from a meeting participant could drive arbitrary tool actions with full shell/filesystem access rooted at the vault. This is a trust-model decision, not a bug. Options: (a) keep the default but add a prominent README "trust boundary" disclosure + a warning in the consent modal; (b) ship a safer default (no flag, or scoped `--allowedTools`) and let power users opt in. **Decision required; at minimum do the documentation half before public release.**

---

## Tier 1 — Critical / High (fix before advertising Windows support or submitting)

### 1. [Critical] ✅ DONE (Batch B) — PS 5.1 mangles `--append-system-prompt` content containing double quotes — every default-config LLM run on Windows fails
**DEVIATION:** Chose fix option 3 (deliver the prompt in the user message on Windows) over option 1 (hand-rolled msvcrt escaping). Rationale: option 1's escaping can't be verified on macOS and is easy to get subtly wrong; option 3 sidesteps command-line quoting entirely and is robust. Cost: no prompt-cache/system-authority on Windows only (POSIX unchanged). Implemented as `windowsUserPrompt` prepended to the stdin trigger in both `buildLlmCommand` and `spawnLlmPromptTerminal`; `buildCliCommand`'s Windows `--append-system-prompt` branch is now unreachable (kept defensive, with `-Encoding UTF8`).
`src/services/LlmInvoker.ts:220-226` (spawn at :343, `buildLlmCommand` at :250)
On Windows the command runs under `powershell.exe` (Windows PowerShell 5.1) and expands the prompt file via `--append-system-prompt "$(Get-Content -Raw -LiteralPath '<sys>')"`. PS 5.1 uses legacy native-arg passing: it does **not** escape embedded `"` when building the child's command line, so any double quote in the prompt splits the argument into garbage tokens. All five bundled prompts in `Prompts/*.md` contain double quotes — this fires on every speaker-tag/summarize/research run with default settings. Additionally, if the CLI resolves to an npm `.cmd` shim, cmd.exe's batch parser drops everything after the first newline.
**Fix (pick one, in preference order):**
1. Pre-escape for msvcrt argv rules inside the subexpression: emit
   `--append-system-prompt "$((Get-Content -Raw -Encoding UTF8 -LiteralPath '<sys>') -replace '(\\+)$','$1$1' -replace '(\\*)\"','$1$1\"')"` (double backslash runs before quotes and at end-of-arg, insert `\` before each `"`).
2. Prefer `pwsh.exe` (PS 7+) when present on PATH — PS 7.3+ argument passing is correct natively — falling back to patched 5.1.
3. Fallback-of-last-resort: on Windows deliver the prompt in the user message (the existing `content === undefined` path) instead of `--append-system-prompt`.
Whichever route: add a manual test with a prompt containing `"`, `\"`, and a trailing backslash (windows-compatibility-plan Phase 6 test #7).

### 2. [High] ✅ DONE (Batch B) — Windows PowerShell 5.1 encoding defaults corrupt all non-ASCII text through the LLM pipeline (three legs)
Added `-Encoding UTF8` to generated `Get-Content`, a `WIN_PS_UTF8_PRELUDE` (`[Console]::OutputEncoding` + `$OutputEncoding` = UTF8) prefixed to the background `-Command` and the debug `.ps1`, and a UTF-8 BOM on the `.ps1`. The system-prompt Get-Content leg is gone on Windows (item 1 fix delivers the prompt via user message).
`src/services/LlmInvoker.ts:300, :223, :343, :515, :518`
(1) Trigger/system-prompt tmp files are BOM-less UTF-8, but PS 5.1 `Get-Content -Raw` without `-Encoding` decodes them as ANSI → "José" becomes mojibake. (2) Piping into a native exe re-encodes via `$OutputEncoding` (default **ASCII** in 5.1) → non-ASCII becomes `?` on stdin. (3) CLI stdout is decoded via `[Console]::OutputEncoding` (OEM codepage) before Node reads it → speaker names in the returned JSON get double-mangled, then enrolled/written corrupted. The debug `.ps1` has the same BOM problem (parsed as ANSI).
**Fix (all inside Windows-only branches):**
- Add `-Encoding UTF8` to every generated `Get-Content` (:223, :300, :515).
- Prefix the `-Command` string (and the `.ps1` body) with `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; `.
- Write the `.ps1` with BOM: `fs.writeFileSync(tmpScript, "﻿" + scriptBody, "utf-8")`.

### 3. [High] ✅ DONE (Batch C) — `waitAndLink` newest-file fallback can link the wrong transcript and cross-wire two meetings' frontmatter
`findNewestFile` now filters `extension === "md"` + basename-prefix match on `info.suggestedFilename`; the wait loop polls only the expected path for the full 15s window and scans the folder once afterward with the same prefix guard.
`src/services/ApiRecording.ts:197-209, 302-311`
When the expected transcript path doesn't exist yet, the 1-second poll loop immediately falls back to `findNewestFile(...)`, which has no `.md` filter and no name matching. With concurrent recordings (a workflow Dan explicitly uses — Tome is patched to accept a new recording while a prior one post-processes), meeting A's wait loop can adopt meeting B's transcript, then `enrichTranscriptFrontmatter` overwrites B's `meeting_note`/`meeting_subject`/`meeting_invitees`/`pipeline_state` with A's data — both meetings silently corrupted. A second variant: the sibling `.m4a`/`.voiceprints.json` can land before the `.md` and get linked as the "transcript". Also note the completion poll (`recordingStatus.state === "complete"`) is global service state, not per-recording.
**Fix:** In `findNewestFile`, filter `child.extension === "md"` and require the basename to match `info.suggestedFilename` (prefix match). In the wait loop, poll only the expected path for the full 15-second window; use the folder-scan fallback exactly once after the window expires, and only adopt a candidate whose basename matches `info?.suggestedFilename` — otherwise report "Transcript file not found".

### 4. [High] ✅ DONE (Batch C) — Transient network failure during token refresh permanently signs the user out and destroys the refresh token
Added a `NETWORK` code to `AuthError`; both `doRefreshToken`s use `throw:false`, wrap transport rejections as `NETWORK`, classify 4xx/OAuth-error bodies as `AUTH_FAILED`, and treat 5xx/missing-token as `NETWORK`. `doRefresh` rethrows `NETWORK` without `signOut()`, preserving the cached refresh token.
`src/services/BaseCalendarAuth.ts:90-105`; `src/services/MsalAuth.ts:159-190`; `src/services/GoogleAuth.ts:151-182`
`doRefresh` treats any non-`AuthError` exception as fatal: it calls `signOut()`, which nulls **and persists** the token cache. Both `doRefreshToken` implementations call `requestUrl` without `throw: false`, so a plain network failure (laptop waking before Wi-Fi reconnects, VPN flap, DNS) throws a generic error → valid refresh token destroyed → full browser re-auth required. Recurring pain on the GCC High tenant.
**Fix:** In both `doRefreshToken`s, use `requestUrl({..., throw: false})` and inspect the response. Only an explicit OAuth error body (`invalid_grant` etc.) / 400-class response becomes `AuthError("AUTH_FAILED")`. Wrap transport failures in a distinct error (e.g. `AuthError(..., "NETWORK")`) that `doRefresh` rethrows **without** calling `signOut()`, leaving the cached refresh token intact for the next attempt.

### 5. [High] ✅ DONE (Batch C) — SpeakerTagModal: Enter to pick an autocomplete suggestion on the last speaker row instantly applies the whole modal
Autocomplete Enter branch now uses `stopImmediatePropagation()`; submit handler bails early when the row's dropdown is visible with a `.is-selected` item.
`src/ui/SpeakerTagModal.ts:453-473` (autocomplete keydown) and `:339-351` (submit keydown)
The autocomplete Enter handler calls `e.stopPropagation()`, which does **not** stop the second keydown listener on the same element — that needs `stopImmediatePropagation()`. So Enter-selecting a dropdown name on the last input also fires the submit handler: the modal closes as "Apply" with possibly-unreviewed LLM proposals in the other rows, and voiceprint enrollment proceeds. On non-last rows, Enter-select unexpectedly jumps focus and closes the dropdown.
**Fix:** In the autocomplete Enter branch (~:465-468), use `e.stopImmediatePropagation()` (in addition to `preventDefault`). Belt-and-braces: have the submit handler bail when that input's dropdown is visible with `selectedIdx >= 0`.

---

## Tier 2 — Medium (fix before release; none require restructuring)

### 6. [Medium] ✅ DONE (Batch B) — `validateLlmCli` rejects absolute CLI paths on Windows, blocking every LLM run
`src/services/LlmInvoker.ts:139-148` (gate at `src/main.ts:1738-1741`)
The Windows validator runs `where.exe <cliPath>`, which searches PATH for a *pattern* and misparses fully-qualified paths → reports no match. Since `runLlmJob` hard-gates on validation, a user who sets an absolute path (the natural workaround for a PATH problem) can never run any LLM job.
**Fix:** Short-circuit in `validateLlmCli` on both platforms: `if (path.isAbsolute(cliPath)) return fs.existsSync(cliPath)`; only fall back to `where.exe` / `command -v` for bare names.

### 7. [Medium] ✅ DONE (Batch B) — Windows `killProcessTree` graceful phase is a guaranteed no-op → orphaned CLI processes when Obsidian quits mid-job
`src/services/LlmInvoker.ts:68-81` (unload escalation at `src/main.ts:412-421`)
The spawn uses `windowsHide: true` (CREATE_NO_WINDOW), so graceful `taskkill /PID <pid> /T` (WM_CLOSE) can never terminate anything. On the timeout path this only wastes the 5 s grace window, but `onunload` relies on a 2 s `setTimeout` for the `/F` escalation — on app quit the renderer dies before the timer fires, leaving orphaned `claude`/`node` processes burning tokens.
**Fix:** Make the Windows branch of `killProcessTree` always pass `["/PID", pid, "/T", "/F"]` regardless of requested signal (POSIX branch untouched). This also removes the wasted 5 s on the timeout path.

### 8. [Medium] ✅ DONE (Batch B) — `closeMeetingApp` graceful `taskkill` just minimizes Teams/Zoom to the tray on Windows — call stays live
`src/services/MeetingAppCloser.ts:37`
`taskkill /IM <name>` without `/F` posts WM_CLOSE, which Teams/Zoom intercept as close-to-tray; the user stays in the meeting with mic/camera unchanged while the UI implies they've left. The macOS branch (SIGTERM via `killall`) actually terminates.
**Fix:** Add `/F`: `execFile("taskkill", ["/F", "/IM", name], ...)`. The call is already best-effort/error-swallowing.

### 9. [Medium] ✅ DONE (Batch E) — `zipSync` blocks the Obsidian UI thread for the whole export and buffers everything in memory (affects macOS too)
Switched to fflate's async `zip()` (Promise-wrapped) with `{level:0}` (store, no deflate) since the payload is dominated by already-compressed `.m4a` audio.
`src/services/MeetingExporter.ts:108-116`
The export switched from an async `zip` subprocess to synchronous in-renderer `fflate.zipSync`, with all inputs (including the meeting audio, tens–hundreds of MB) and output held in memory. Deflating already-compressed `.m4a` is slow and pointless — the UI freezes for the duration.
**Fix:** Use fflate's async `zip()` (callback-based), and pass `{level: 0}` for audio entries (or the whole archive).

### 10. [Medium] ✅ DONE (Batch D) — "Speakers already tagged" guard downgrades a summarized meeting note back to "tagged"
The heal now mirrors the transcript's actual `state` instead of hard-coding "tagged".
`src/main.ts:668-675`
The early guard in `doTagSpeakers` fires for any transcript state ≠ "titled" — including "summarized" — and unconditionally "heals" the meeting note to `pipeline_state: tagged`. Re-running Tag speakers on a summarized meeting regresses the note's state, re-offers Summarize, and lets `doSummarize` run a duplicate summary.
**Fix:** Mirror the transcript's actual state (`updateFrontmatter(..., FM.PIPELINE_STATE, state)`) instead of hard-coding "tagged"; or only heal when the note's current state is absent/"note"/"titled".

### 11. [Medium] ✅ DONE (Batch D) — DST fall-back day: `getDayEndUTC` returns the day's *start* → day cached as permanently empty
**DEVIATION:** Instead of string-based calendar arithmetic (which reintroduces a tz-anchor edge case for UTC+13/+14 zones), normalize to this day's `midnightInTimezone` and step **26h** forward before snapping — a civil day is ≤25h, so 26h always lands strictly inside the next calendar day and snaps back to next-day midnight on normal/spring-forward/fall-back days alike. Outcome is identical, no tz-anchor fragility.
`src/utils/time.ts:50-53` (triggered from `src/services/CalendarCache.ts:211-226`)
On a 25-hour fall-back day, local midnight + 24 h is still 23:00 of the same day, so `end === start`. `prefetchFutureDays` then queries Graph with `startDateTime === endDateTime` → zero events → caches the day as empty. If the user doesn't open Obsidian on the day itself, it rolls into the past-day cache, which is served forever — every meeting on that day permanently invisible (next occurrence: Nov 1 2026, America/New_York).
**Fix:** Compute the end by calendar arithmetic on the date key: format `date` to `YYYY-MM-DD` in the target zone, add one calendar day, and run `midnightInTimezone` on that — rather than instant +24 h.

### 12. [Medium] ✅ DONE (Batch D) — Speaker-tag completion tail runs after the job slot is released — second run can race the restore/apply writes
The speakerTag `onSuccess` is now `async` and awaits `restoreTranscriptBody`/`handleSpeakerTagSuccess`; `handleSpeakerTagSuccess` fire-and-forgets only `presentSpeakerTagModal` (voided), so the non-interactive writes finish before `runLlmJob`'s finally releases the slot.
`src/main.ts:849-859` (onSuccess voids the handler) and `:1776-1798` (`runLlmJob` awaits `onSuccess`, then `finally` cleans up)
`runLlmJob` deliberately awaits `onSuccess` so completion writes land before cleanup — but the speaker-tag caller defeats this by `void`ing `handleSpeakerTagSuccess(...)` / `restoreTranscriptBody(...)`. The `finally` releases the job and concurrency slot while the tail (tripwire read, snapshot restore, `writeSpeakerProposals`, auto-apply) is still mutating the transcript. A user re-clicking Speakers (or the auto-tagger re-dispatching) in that window interleaves `vault.process` writes and can snapshot half-restored content as the new "restore" baseline.
**Fix:** Make the speakerTag `onSuccess` async and await the non-interactive tail (through `writeSpeakerProposals`/tripwire/frontmatter-restore; `await restoreTranscriptBody` on the failure path). Only the modal presentation (`presentSpeakerTagModal`) stays fire-and-forget — it already serializes on `speakerTagModalQueue`.

### 13. [Medium] ✅ DONE (Batch E) — CalendarView day off-by-one whenever configured timezone ≠ system timezone
Added `midnightFromDateKey`/`addDaysInTimezone` to time.ts (calendar arithmetic on UTC date parts, then snap to the zone's midnight). `navigateDay` uses `addDaysInTimezone`; `onActiveFileChanged` builds the day via `midnightFromDateKey(meetingDate, tz)` so the comparison equalizes and the debounce isn't defeated. The `new Date()` ("now"/today) assignments are left as-is — they format correctly in any zone.
`src/ui/CalendarView.ts:1452-1461` (`navigateDay`), `:904-909` (`onActiveFileChanged`), `:292-299` (midnight rollover)
`selectedDate` is built at *system-local* midnight (`new Date(y, m-1, d)`) but always rendered/compared via `formatDate(date, settings.timezone)`. With a configured zone west of the system zone: "next day" appears dead on first click, all displayed days shift, and `onActiveFileChanged` navigates to the wrong day — and since the comparison never equalizes, every leaf change resets `lastRefreshTime = 0` and re-fetches, bypassing the debounce indefinitely.
**Fix:** Canonicalize the selected day as a `YYYY-MM-DD` string in `settings.timezone` (or construct via the existing `midnightInTimezone` helper in `src/utils/time.ts`). In `navigateDay`/`onActiveFileChanged`, derive the new day by formatting in `settings.timezone`, doing calendar-day arithmetic, and converting back with `midnightInTimezone`.

### 14. [Medium] ✅ DONE (Batch E) — Auto-refresh does a full teardown re-render: scroll position resets and in-progress merge selection is wiped every 5 minutes
`refresh({background:true})` skips `renderLoading` when `cachedEvents` exists and captures/restores `contentContainer.scrollTop` across the re-render. The timer skips the tick entirely while `mergeSelection.size > 0` (chosen over id-diffing for simplicity/safety).
`src/ui/CalendarView.ts:315` (`renderLoading` inside `refresh`), `:506-513` (`renderEvents` clears `cards`/`mergeSelection`), `:1521-1528` (`startAutoRefresh`)
The timer refresh unconditionally renders "Loading calendar..." (collapsing scroll to top) and rebuilds all cards, clearing merge mode and checked selections mid-use.
**Fix:** For background/timer refreshes when `cachedEvents` exists, skip `renderLoading` and render new events directly; capture the scroll container's `scrollTop` before re-render and restore after. Preserve `mergeSelection` by dropping only ids no longer present (or skip the timer refresh entirely while `mergeSelection.size > 0`).

### 15. [Medium] ✅ DONE (Batch E) — ResearchModal: advertised "leave empty to research from the meeting note alone" flow silently acts as Cancel
Submit now blocks only bypass-mode-with-empty-prompt (visible inline `whisper-cal-research-error`); a submitted-empty normal-mode close resolves a valid `{paths:[], instructions:"", bypassPrompt:false}`. Error clears on typing / bypass toggle.
`src/ui/ResearchModal.ts:156` (help text) vs `:404-413` (`onClose` validation)
Clicking Research with nothing selected and no instructions resolves `null` — indistinguishable from Cancel, no feedback — contradicting the help text.
**Fix:** Honor the help text: treat submitted-with-empty as a valid `{paths: [], instructions: "", bypassPrompt: false}` result. For bypass mode with empty textarea, block submission with a visible inline error instead of silently dismissing.

### 16. [Medium] ✅ DONE (Batch D) — Speaker-tag apply/enroll uses the transcript path string captured before the LLM run — rename mid-flight discards the user's entire review
Both apply paths now resolve `const currentPath = transcriptFile.path;` at use time and use it for applySpeakerTags/enrollVoiceprints/healVoiceprints/applyWordReplacements (and the auto-apply path).
`src/main.ts:1090` (`applySpeakerTags(this.app, transcriptPath, ...)`), also `:1100` (`enrollVoiceprints`) and `:1310` (`autoApplyVoiceprintTags`); throw site `src/services/SpeakerTagApplier.ts:19-22`
The modal receives both a live `TFile` (path stays current across renames) and a frozen path string captured at job spawn. If the user renames the note + related files while the LLM job runs (card ⋯ → Rename), the apply throws "Transcript file not found", the queue's catch swallows it, and every by-ear confirmation is lost.
**Fix:** Resolve at use time: `const currentPath = transcriptFile.path;` immediately before `applySpeakerTags`/`enrollVoiceprints`/`hasCachedProposals` in `presentSpeakerTagModal` and the auto-apply path.

### 17. [Medium] Vault-visible voiceprint files use `vault.adapter` instead of the Vault API (top Obsidian review-team flag)
`src/services/VoiceprintMatcher.ts:51-56`, `src/services/VoiceprintEnroller.ts:148-216, 355, 419`, `src/services/ApiUnlinkedProvider.ts:193, 233`
Voiceprint libraries live in a user-visible vault folder (default `Caches/Voiceprints`) but are accessed via `adapter.exists/read/write/list/remove/rename`, bypassing Obsidian's file cache and sync safety. "Prefer the Vault API over the Adapter API" is an explicit review guideline — this is the most likely concrete comment on the submission PR. (`CalendarCache.ts`'s adapter use is fine: that file lives under `manifest.dir` inside `.obsidian`, unreachable by the Vault API.)
**Fix:** For in-vault paths use `vault.getFileByPath`/`vault.create`/`vault.process`/`vault.delete` and `fileManager.renameFile` (or `vault.rename`); replace `adapter.list` with `vault.getFolderByPath(...)` + `.children`. Keep adapter only for the plugin-dir cache file. Take care to preserve existing behavior for the JSON read/modify/write cycles (these files are also written outside Obsidian by Tome sidecars — verify `vault.getFileByPath` sees externally-created files; may need `vault.adapter.exists` → `app.vault.getAbstractFileByPath` after a metadata refresh, or keep adapter for the sidecar-adoption path only and note why).

---

## Tier 3 — Low / polish (sweep opportunistically before submission)

### Security
- **18. Randomize the heredoc delimiter (POSIX LLM path).** `src/services/LlmInvoker.ts:303` — the fixed `__WCAL_EOF__` sentinel means a line of exactly that text in attendee names/roster/instructions breaks out of the heredoc into the login shell. Use a randomized per-invocation delimiter, or pipe the trigger from the tmp file (`< tmpTrigger`) as the Windows and debug paths already do.
- **19. Tighten LLM tmp dir/file permissions.** `src/services/LlmInvoker.ts:53-57, 278-285, 297-299` — prompt/trigger tmp files are world-readable and inside the (possibly synced) vault. Set mode `0o700` on the dir / `0o600` on files, or move to `os.tmpdir()`.
- **20. Pin the loopback error branch to text/plain.** `src/services/LoopbackOAuthServer.ts:74-76` — currently safe *because* it's `text/plain`; add a comment that the content type must never become `text/html` (reflected provider `error` string).

### Windows polish
- **21. ✅ DONE (Batch B) — Filter PS NativeCommandError decoration from stderr excerpts.** New `cleanLlmStderr` in LlmInvoker.ts drops `At line:` / `+ CategoryInfo` / `+ FullyQualifiedErrorId` / caret lines; used at both main.ts excerpt sites (replaced `stripAnsi`). `src/services/LlmInvoker.ts:343`, consumed at `src/main.ts:1468, 1648` — drop `+ CategoryInfo` / `+ FullyQualifiedErrorId` / `At line:` lines before the 200-char excerpt so Windows users see the CLI's real error.
- **22. Cap `sanitizeFilename` length.** `src/utils/sanitize.ts:13-19` — no length cap; long Outlook subjects + `" - Transcript.voiceprints.json"` suffixes can exceed MAX_PATH (260) on Windows and fail late at sidecar rename. Truncate to ~120 chars, then re-strip trailing dots/spaces.
- **23. Legacy-name fallback for the new trailing-dot strip.** `src/utils/sanitize.ts:16-18` (consumers: `VoiceprintEnroller.ts:319`, `SeriesPrep.ts:43`, `NoteCreator.ts:98`) — names ending in `.` now sanitize differently than before, so existing artifacts ("Robert Smith Jr..json" voiceprint libraries, series notes) are orphaned and duplicates get created. When a sanitized-path lookup misses, also probe the legacy un-stripped name (or one-time rename on match).

### Core / correctness polish
- **24. `parseDateTime` should honor `settings.timezone`.** `src/utils/time.ts:149-178`, call sites `src/main.ts:1908-1919`, `src/services/MeetingMerger.ts:64-65` — frontmatter times are written in the configured zone but parsed in the system zone; traveling users get ±hours offsets and "No matching recording found". Thread the timezone through using the existing `computeOffset`/`midnightInTimezone` machinery.
- **25. Distinguish MacWhisper DB errors from empty results.** `src/services/MacWhisperDb.ts:84-103` — `query()` resolves `"[]"` on any `execFile` failure (locked DB, missing sqlite3), so real errors surface as "No matching recording found". Reject or return a sentinel; callers surface "Couldn't read the MacWhisper database" once.
- **26. Handle a synced calendar-provider switch in `onExternalSettingsChange`.** `src/main.ts:424-441` — replicate the provider-rebuild branch from `saveSettings` (`:538-568`) or factor it into a shared method; currently machine B keeps the old provider stack after a synced Microsoft→Google switch.
- **27. Fix mixed-timezone display in unlinked-recording cards.** `src/ui/CalendarView.ts:1439-1449` — date part formats in system tz, time part in `settings.timezone`; add `timeZone: this.settings.timezone` to `toLocaleDateString` and compute `sameYear` tz-aware.
- **28. Guard double-click on "Review speakers".** `src/ui/MeetingCard.ts:1258-1259`, `src/main.ts:1352-1363` — two queued modals; the second opens with pre-apply stale proposals. Disable the button until the chain settles, or keep an in-flight `Set` keyed by transcript path.

### Settings / UI polish
- **29. Make rejected numeric/timezone settings input visible.** `src/settings.ts:336-359` (+ float fields `:766-775, :806-815, :826-835`, timezone `:462-470`) — invalid input is silently ignored while the field keeps showing it. Add an error class or reset to the stored value on blur; validate with `/^\d+$/`/`Number()` instead of `parseInt` (which accepts `"5x"`).
- **30. Keyboard accessibility for click-only divs.** Card title (`MeetingCard.ts:553-560`), join/organizer links (`:309, :578` — `<a>` without href), Today button (`CalendarView.ts:149-150`), unlinked-section header (`:1028-1039`), SpeakerTagModal disclosure/timestamps/caret (`:256-266, :161-166, :490-500`), ResearchModal disclosure/rows/chips (`:139-147, :368-388, :271-277`), organizer chip remove (`settings.ts:1264-1274`). Convert to `<button>` or add `tabindex="0"` + `role` + Enter/Space handlers.

### Obsidian directory compliance polish
- **31. Use `Modal.setTitle()` instead of `<h2>/<h3>` in contentEl** — ten modals: `settings.ts:186`, `NameInputModal.ts:28`, `MergeConfirmModal.ts:51`, `WordReplacementModal.ts:37`, `RenameNoteModal.ts:47`, `DeleteTranscriptModal.ts:28`, `ActiveRecordingNoticeModal.ts:23`, `ModalHeader.ts:57`, `CachedProposalModal.ts:25`, `DeleteNoteModal.ts:43`. Review bot flags raw heading elements.
- **32. `normalizePath` user-configured folder paths on save.** `settings.ts:265-305` folder inputs store verbatim; `main.ts:228` does `startsWith(transcriptFolderPath + "/")` (a trailing slash silently disables transcript→note mirroring); `VoiceprintEnroller.ts:319` concatenates un-normalized. Normalize+trim in `addTextSetting` for path inputs, or at the two consumption sites.
- **33. Replace the one inline style with a CSS custom property.** `MeetingCard.ts:1111` `el.style.animationDelay` → `el.setCssProps({"--whisper-cal-seg-delay": ...})` + `animation-delay: var(--whisper-cal-seg-delay)` in styles.css.
- **34. Replace hardcoded red with a theme variable.** `styles.css:1413` `#e53935` → `var(--color-red)`.
- **35. Stop hardcoding the plugin folder name in the tmp path.** `LlmInvoker.ts:54` hardcodes `"plugins/whisper-cal"`; thread `manifest.dir` (available in `main.ts:177`) into `LlmInvokerOpts`.
- **36. README Disclosures: add the two missing plaintext secrets.** Add one bullet: the optional Anthropic API key (`settings.ts:1148`) and the Google OAuth client secret (`settings.ts:31`) are stored unencrypted in `data.json` alongside OAuth tokens.
- **37. Collapse `versions.json`.** ~330 redundant entries; only two minAppVersion boundaries exist. Collapse to `{"0.1.0": "1.4.10", "0.8.1": "1.6.0"}`.
- **38. (No code change) `app.setting` private API.** `main.ts:212-216` — tolerated, already optional-chained; be ready to justify in the submission PR.

---

## Verified clean — do NOT re-audit these

The review explicitly confirmed the following, so implementers should not "fix" them:

- **Build/lint:** both pass clean with `eslint-plugin-obsidianmd`.
- **Obsidian hard blockers:** manifest fields compliant (`isDesktopOnly: true`, no banned words, description style OK); no `innerHTML`/`insertAdjacentHTML` anywhere; no global `app`; no default hotkeys; no `detachLeavesOfType` in `onunload`; no `vault.modify` (uses `vault.process`); frontmatter via `fileManager.processFrontMatter` with a per-file queue; all listeners via `registerEvent`/`registerDomEvent`, intervals via `registerInterval`; `onunload` cleanup is thorough (auto-tag queue, watchers, loopback server, card timers, cache flush, LLM child kill); network exclusively via `requestUrl`; `main.js`/`data.json` gitignored; release assets correct; sentence-case command names.
- **Security:** loopback server binds 127.0.0.1 only, validates `state`, 5-min timeout, idempotent stop; S256 PKCE with `randomBytes` verifier/state on both providers; read-only scopes; SQL guarded by `isValidHexId` hex validation; no XSS surface (all `createEl`); `sanitizeFilename` blocks path traversal; zip export path handling safe; no secrets in logs; osascript strings built only from plugin-generated escaped paths; token-storage disclosure already in README.
- **Job lifecycle:** `runLlmJob`'s `finally` reliably clears jobs/slots/status — cards can't stick in "running" (the item-12 race is about writes after release, not stuck UI).
- **Concurrency guards:** record/stop/link buttons disable synchronously; LLM launches gated by `jobs.has()`; modal promises resolve on all dismissal paths; settings `display()` re-entrancy handled; `hide()` flushes debounced saves.
- **Windows port (rest of it):** Tome `%APPDATA%` port-file discovery, rename retry, reserved-device-name sanitization, platform gating of MacWhisper surfaces, `recordingSource` migration on non-macOS, microphone-user autofill, loopback OAuth on Windows — all correct as written.
- **Vector math:** `vec.ts`/`VoiceprintMatcher` cosine/centroid math sound, including empty/mismatched-dimension edges.
- **styles.css:** all selectors `whisper-cal-`-prefixed; 359 theme-variable uses (the two hardcoded colors are items 34 and an intentional white shimmer).

---

## Execution order & post-batch protocol

Execute as eight batches, in this order. Each batch is one commit.

| Batch | Items | Scope |
|---|---|---|
| A | D2 docs half (+ D1/D2 code changes only if Dan has decided) | Trust-boundary disclosure in README/consent modal |
| B | 1, 2, 6, 7, 8, 21 | Windows LLM path (`LlmInvoker.ts`, `MeetingAppCloser.ts` Windows branches) |
| C | 3, 4, 5 | Data-loss/corruption Highs (independent files) |
| D | 10, 11, 12, 16 | Pipeline-state and speaker-tag integrity |
| E | 13, 14, 15, 9 | UX-visible mediums |
| F | 17 | Adapter→Vault API migration (biggest diff — deliberately isolated) |
| G | 18–30 | Tier 3 mechanical sweep (security, Windows, correctness, UI polish) |
| H | 31–37 | Directory compliance polish |

**Post-batch protocol — run after EVERY batch, before starting the next:**

1. `npm run build && npm run lint` — both must exit clean. If not, fix within the batch; never carry a red build into the next batch.
2. Re-read the diff for the batch (`git diff`) and confirm each item's fix matches what this plan specified; note any deliberate deviation inline in this document next to the item.
3. Check off the batch's items in this document (edit the plan file itself) so a resumed or fresh session can see progress.
4. Commit the batch on its own, with a message naming the batch and item numbers (e.g. `Fix Windows LLM path: PS 5.1 quoting, encoding, taskkill (review items 1,2,6,7,8,21)`). One commit per batch keeps each independently revertable. Git email is dloomis@gmail.com.
5. For batches C, D, E, F: deploy to the test vault (`cp main.js manifest.json styles.css ~/SDA/.obsidian/plugins/whisper-cal/`), reload Obsidian, and spot-check the touched flow (C: link a recording + sign-in survives offline toggle; D: re-run Tag speakers on a summarized note; E: navigate days + let an auto-refresh tick pass + export a bundle; F: full enrollment/matching/sidecar-adoption pass). Batch B cannot be verified on macOS — flag it for the Phase 6 Windows-machine test instead of claiming it verified.

**After the final batch:** deploy to `~/SDA` and run the four-stage pipeline end-to-end (Note → Transcript → Speakers → Summary) on a real meeting before cutting a release. Windows support must additionally pass `Plans/windows-compatibility-plan.md` Phase 6 on a real Windows machine before it is advertised.
