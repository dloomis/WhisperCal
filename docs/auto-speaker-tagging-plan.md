# Auto-Run Speaker Tagging in Background (never auto-apply)

Status: implemented (2026-06-07) as `src/services/AutoSpeakerTagger.ts` plus the main.ts/MeetingCard/settings changes below.

## Context

Today every speaker-tagging run starts with a manual Speakers-pill click. The user always reviews/corrects LLM speaker proposals anyway, so the LLM run itself is pure waiting. This feature runs the **existing** speaker-tagging job automatically in the background when a transcript becomes ready (`pipeline_state: titled`, linked to a meeting note), then **stops after caching proposals to frontmatter** — no modal, no tag application, no `pipeline_state` advance. The user later clicks the Speakers pill, which already pops `CachedProposalModal` (view candidates / rerun) — unchanged. A small accent dot on the Speakers pill signals "candidates ready". Auto-summarize-after-tagging is untouched: it already fires only inside `presentSpeakerTagModal` after the user applies (`main.ts:728`), which auto mode never reaches.

This deliberately differs from the unimplemented `docs/auto-pipeline-plan.md` Stage B (which auto-*applies* confident tags): here, nothing is ever applied without review. The new service should be the seed that a future auto-apply Stage B extends rather than duplicates.

**Confirmed user decisions:**
- Skip single-source transcripts (they need manual hints via `LlmInstructionsModal`)
- Startup catch-up scan with configurable lookback setting (default 48h, 0 disables)
- **No new mode toggle — the existing `autoSummarizeAfterTagging` setting becomes the automatic/manual mode switch**: on = automatic mode (auto-tag new transcripts in background → user reviews/applies via pill → auto-summarize fires, as it already does), off = today's fully manual flow. Same settings key, relabeled in the UI.

## Key facts discovered (load-bearing — verified)

- `handleSpeakerTagSuccess` already caches proposals via `writeSpeakerProposals` (`main.ts:649`) *before* showing the modal (`:651`) — auto mode = stop after caching.
- `doTagSpeakers` (`main.ts:531`) already handles the later pill click: `hasCachedProposals` → `CachedProposalModal` → view/rerun (`:546-559`). **No modal changes needed.**
- `runLlmJob`'s `onSuccess` fires even on nonzero exit (`main.ts:1045`, after appending the LLM error section at `:1034-1043`) — auto mode must branch on `result.exitCode`.
- Writing proposals does **not** re-render cards: CalendarView's listener dedupes on `getFmKey` (`CalendarView.ts:1056-1067`), whose `FM_KEYS` exclude the speakers/proposals array. Must call `refreshCalendarCards(transcriptPath)` explicitly after `writeSpeakerProposals`.
- `runLlmJob` **drops** jobs at the concurrency cap with a Notice (`main.ts:980`) — the auto path needs its own slot-wait before invoking. The auto path from `doTagSpeakers` to `runLlmJob` is synchronous (auto skips the only `await` — the modal prompt), so a pre-checked slot can't be raced away.
- With `llmDebugMode` on, runs open Terminal.app — auto must skip when debug mode is on.
- Available utilities: `debug()` (`src/utils/debug.ts:18`), `getMarkdownFilesRecursive` (`src/utils/vault.ts:31`), `isSingleSourceTranscript` (`src/utils/frontmatter.ts:84`), `hasCachedProposals` (`src/services/SpeakerTagParser.ts:252`), `addNumberSetting` accepts a `container` (`settings.ts:263`).

## Changes

### 1. NEW `src/services/AutoSpeakerTagger.ts` (~180 lines)

Service owning trigger, eligibility, queue, and catch-up scan. Constructed with deps (no recreate on settings change — reads live settings via getter):

```ts
interface AutoSpeakerTaggerDeps {
  app: App;
  getSettings: () => WhisperCalSettings;
  jobs: JobTracker;
  canStartLlm: () => boolean;   // () => activeLlmCount < llmMaxConcurrent
  runAutoTag: (file: TFile, fm: Record<string, unknown>, notePath: string) => void;
  registerEvent: (ref: EventRef) => void;  // plugin.registerEvent
}
```

Constants: `SETTLE_MS = 10_000` (lets linkToNote's rename + note-side fm writes finish), `SLOT_POLL_MS = 30_000`, `MAX_SLOT_WAIT_MS = 30 * 60_000`, `CATCHUP_DELAY_MS = 10_000`.

State: FIFO `queue: {file: TFile; eligibleAt: number}[]` (holds live `TFile` — path auto-updates on rename), `attempted: Set<string>` (session-scoped loop guard for failed/zero-mapping runs), `pumping`, `stopped` flags, cancellable sleep.

- **`start()`** (called from `onLayoutReady`): register via `deps.registerEvent`:
  - `metadataCache.on("changed")` filtered to `settings.transcriptFolderPath + "/"` → `maybeEnqueue(file)`
  - `vault.on("delete")` → drop from `attempted` + queue (re-arms re-record)
  - `vault.on("rename")` → drop old path from `attempted`
  - schedule `catchUpScan()` after `CATCHUP_DELAY_MS`
- **`isEligible(file)`** — single predicate reused by listener, scan, and dequeue re-check (returns `{ok, fm, notePath} | {ok: false}`; log skip reasons via `debug("autoTag", …)`):
  1. `settings.autoSummarizeAfterTagging` (automatic mode on) 2. `llmEnabled` 3. `!llmDebugMode` 4. `speakerTaggingPromptPath` set 5. `.md` under transcript folder 6. fm `pipeline_state === "titled"` (strict) 7. `resolveWikiLink(app, fm, FM.MEETING_NOTE, path)` resolves → notePath 8. `!isSingleSourceTranscript(fm)` 9. `!hasCachedProposals(app, path)` 10. `!jobs.has("speakerTag", path)` 11. `!attempted.has(path)`
- **`maybeEnqueue(file)`** — dedupe by `TFile` identity in queue + predicate; push with `eligibleAt = now + SETTLE_MS`; kick `pump()`.
- **`pump()`** — single-consumer serial loop: wait for `eligibleAt`; wait for `canStartLlm()` (poll `SLOT_POLL_MS`, bounded by `MAX_SLOT_WAIT_MS` — on timeout drop *without* marking attempted so it re-arms later); **re-run `isEligible` at dequeue**; mark `attempted` *before* invoking (failed runs write nothing, so this is the anti-loop marker; success's cached proposals make guard 9 the durable marker); call `deps.runAutoTag(...)`.
- **`catchUpScan()`** — if `autoTagLookbackHours <= 0` return; `getMarkdownFilesRecursive` over the transcript folder, filter `file.stat.ctime >= now - hours*3_600_000`, sort by ctime, `maybeEnqueue` each.
- **`stop()`** — set `stopped`, clear queue/timer, cancel parked sleep.

### 2. `src/main.ts`

- Construct `AutoSpeakerTagger` in `onload()`; `start()` inside the existing `onLayoutReady` (`main.ts:90`); `stop()` first in `onunload()`. `runAutoTag` → `void this.doTagSpeakers(file, fm, notePath, undefined, {auto: true})`.
- **`doTagSpeakers` (`:531`)**: add `opts?: {auto?: boolean}` param. In auto mode: silent `return` instead of Notice/heal at the state guard (`:539`), silent return instead of `CachedProposalModal` (`:547`), silent return at the prompt-path guard (`:561`). Replace `onSuccess` (`:619`) with:
  ```ts
  onSuccess: (result) => {
    if (auto && result.exitCode !== 0) {
      this.setCardStatus(notePath, "Speaker tagging failed — see meeting note for details", "alert-circle", 8000, "warning");
      return;
    }
    void this.handleSpeakerTagSuccess(result.stdout, transcriptFile, transcriptPath, notePath, auto);
  },
  ```
- **`handleSpeakerTagSuccess` (`:623`)**: add `auto = false` param. In auto: card warning status instead of Notices for deleted-file / zero-mappings cases. After `writeSpeakerProposals` (`:649`) add `this.refreshCalendarCards(transcriptPath);` **unconditionally** (fixes the badge for the existing manual-dismiss case too). Then:
  ```ts
  if (auto) {
    // eslint-disable-next-line obsidianmd/ui/sentence-case
    this.setCardStatus(notePath, "Speaker candidates ready — click Speakers to review", "users-round", 8000, "done");
    return;
  }
  ```
  `presentSpeakerTagModal` and the auto-summarize call inside it stay manual-only (so in automatic mode, summarization starts only after the user applies tags — the desired human gate).

### 3. `src/ui/MeetingCard.ts` — pill badge

- Import `hasCachedProposals` from `../services/SpeakerTagParser`.
- `PillStates`: add `speakersCandidatesReady: boolean`. In `computePillStates` (`:264`): `speakers === "incomplete" && transcriptPath !== "" && hasCachedProposals(app, transcriptPath)`.
- After `renderPill(speakersWrap, …)` (`:809`): if ready, `speakersPill.createSpan({cls: "whisper-cal-pill-tag-dot"})` + aria-label "Speakers (candidates ready for review)". Click behavior untouched (already routes to `CachedProposalModal`).

### 4. `styles.css` — after rec-dot block (~line 944)

Mimic `whisper-cal-pill-rec-dot` (6px, absolute top/right 5px inside the pill) but `background: var(--interactive-accent)`, **no pulse** (persistent cue shouldn't blink), and fade out on `.whisper-cal-pill-wrap:hover` so the "+" instruct affordance owns the corner:

```css
.whisper-cal-pill-tag-dot { position: absolute; top: 5px; right: 5px; width: 6px; height: 6px;
  border-radius: 50%; background: var(--interactive-accent); pointer-events: none; transition: opacity 0.15s ease; }
.whisper-cal-pill-wrap:hover .whisper-cal-pill-tag-dot { opacity: 0; }
```

### 5. `src/settings.ts` — repurpose the existing toggle as the mode switch + one new setting

- **Keep the key `autoSummarizeAfterTagging`** (no migration; existing installs keep their value). Add a comment on the interface field (~`:56`): it now gates the whole automatic mode (auto-tag + auto-summarize), not just summarization.
- New interface field + default: `autoTagLookbackHours: number` (48).
- Relabel the existing toggle (`:807-810`), moving it to the top of the speaker-tagging cluster since it now governs the workflow: name **"Automatic mode"** — desc "Run the LLM workflow automatically: when a transcript is linked to a meeting note, tag speakers in the background and cache the candidates (the Speakers pill shows a dot when they're ready to review — tags are never applied without your confirmation), then start summarization after you apply them. Single-mic recordings are skipped. Off = run each stage manually from the pills." Convert from `addToggleSetting` to a direct `Setting` so its `onChange` toggles visibility of a container div holding `addNumberSetting({container, name: "Auto-tag catch-up window (hours)", desc: "On startup, also auto-tag eligible transcripts created within this many hours. 0 disables the startup scan.", min: 0, …})`. Section is already inside the sentence-case eslint-disable block.
- The auto-summarize trigger at `main.ts:728` keeps reading the same setting — unchanged.

### 6. Docs

- **README.md**: short "Automatic mode" paragraph in the Speakers stage section (what automates, the always-review gate, the pill dot, single-mic skip, catch-up window) + update the "Auto-summarize after tagging" rows in the LLM settings table(s) to the new "Automatic mode" name/desc and add the catch-up window row.
- **docs/auto-pipeline-plan.md**: one status note — Stage B's trigger/queue/catch-up machinery now exists as `AutoSpeakerTagger` in cache-only/never-apply form; future auto-apply work should extend it.

## Edge cases handled

- **Loop safety**: success → proposals cached → guard 9 blocks; failure/zero-mappings → `attempted` blocks for the session; auto never writes `pipeline_state`, so the mirror listener (`main.ts:157`) is unaffected.
- **Rename by `linkToNote` mid-settle**: queue holds live `TFile`; dequeue re-check uses current path/fm.
- **Manual click vs queue race**: JobTracker check (guard 10) at dequeue; pill is disabled while "running"; `runLlmJob` dedupe is the backstop.
- **Toggle off / unload mid-queue**: dequeue re-check drains silently; `stop()` cancels parked sleeps; listeners die via `registerEvent`.
- **Re-record**: transcript delete clears `attempted` → new transcript re-arms.
- **Slot starvation**: after 30 min of polling, head item dropped *without* marking attempted → re-arms on next fm change or next startup scan.

## Verification

1. `npm run build` && `npm run lint`.
2. Deploy `main.js` + `styles.css` (+ `manifest.json`) to `~/SDA/.obsidian/plugins/whisper-cal/`, reload Obsidian.
3. Scenarios:
   - **Manual mode** (toggle off, default): link a recording → no auto behavior; pills work as today; applying tags does NOT auto-summarize (regression baseline).
   - **Automatic mode** (toggle on): link a recording → ~10s later pill pulses "running" with "Tagging speakers…" status → completes with "Speaker candidates ready" status, **no modal**, transcript fm has `proposed_name/confidence/evidence`, `pipeline_state` still `titled`, accent dot on Speakers pill (fades out on hover under the "+").
   - Click Speakers → `CachedProposalModal` → View → prefilled `SpeakerTagModal` → Apply → `tagged`, dot gone, summarization starts automatically (same toggle).
   - Single-source transcript reaching `titled` → skipped (check debug log).
   - Catch-up: restart with an eligible recent transcript → scanned + tagged; lookback 0 → no scan; older than window → skipped.
   - Failure (bogus model flag) → warning status + LLM error section in note; no re-runs on later fm edits; restart re-arms once.
   - `llmMaxConcurrent: 1` + a running manual summarize → auto job waits, runs when the slot frees.
