# Auto-Pipeline: Hands-Free Transcript Processing (Crypt-style)

Status: planned, not implemented (2026-06-06)

> **Update 2026-06-07:** Stage B's trigger/queue/catch-up machinery now exists as `src/services/AutoSpeakerTagger.ts` in a cache-only/never-apply form (see `docs/auto-speaker-tagging-plan.md`): it auto-runs speaker tagging when a transcript reaches `titled`, then stops after caching proposals — no auto-apply, no state advance. Future auto-apply Stage B work should extend that service (e.g. add a confidence-gated apply step after `handleSpeakerTagSuccess`) rather than duplicate the trigger plumbing.

## Context

Today every pipeline stage requires a pill click: link recording → Speakers → Summary, with two human gates (the event-picker modal and the speaker-confirmation modal). The goal is the Crypt model (gremble.io/crypt.html): Tome drops a transcript `.md` into the vault's Transcripts folder, and WhisperCal picks it up — matches it to a calendar meeting, creates/links the note, tags speakers, and summarizes — with no intervention unless something needs a judgment call.

Nearly all machinery exists; this feature adds a **watcher + orchestrator** that walks the existing state machine (`unlinked → titled → tagged → summarized`) through the two human gates automatically.

**Confirmed design decisions:**
- Matching: timestamp-window first; LLM tiebreak only when multiple candidates
- No calendar match → auto-create unscheduled note and continue
- Auto-apply only CERTAIN + HIGH speaker proposals; LOW/unresolved keep stubs and the modal remains available to finish stragglers
- State-driven scope: **any** transcript reaching `titled` auto-tags (Tome-dropped, Record-pill, or manual Link), then auto-summarizes

## Architecture

```
Tome writes .md ──► vault.on("create") watcher ─┐
Obsidian startup ─► catch-up scan (48h)        ─┤
                                                ▼
                                     [Stage A: auto-link]
                          fetchEvents(day) → window filter
                          1 match → link · N matches → LLM tiebreak (fallback: closest)
                          0 matches → unscheduled note
                                                ▼  pipeline_state: titled
Record-pill / manual Link also land here ──► [Stage B: auto-tag]
                          existing metadataCache.on("changed") hook
                          doTagSpeakers(auto) → apply CERTAIN/HIGH w/o modal
                                                ▼  pipeline_state: tagged (only if ALL resolved)
                                     [Stage C: auto-summarize]
                          doSummarize(notePath, true)  → summarized
```

## Files

### New: `src/services/AutoPipeline.ts`
Class owning triggers + Stage A. Constructed in `main.ts onload` with `{app, settings, provider (CachedCalendarProvider), unlinkedProvider, noteCreator: new NoteCreator(app, settings), callbacks}`.

- `start()` — called inside `workspace.onLayoutReady` (avoids initial-scan create events):
  - register `vault.on("create")` (via plugin `registerEvent`), filtered to `.md` under `settings.transcriptFolderPath + "/"`
  - run catch-up scan: `ApiUnlinkedProvider.findUnlinked()` (`src/services/ApiUnlinkedProvider.ts:23`), filtered to files with `ctime` within a 48h constant (`AUTO_PIPELINE_LOOKBACK_MS`) — prevents mass-processing a 30-day backlog on first enable
- `handleTranscriptCreated(file)` — wait ~20s settle delay (Tome finishing writes; metadataCache indexing; gives the Record-pill `waitAndLink` flow time to claim the file), then re-read frontmatter; skip if `meeting_note` already set (pill flow owns it — Stage B fires via the state hook instead)
- `autoLink(file)` — Stage A, mirroring `CalendarView.handleLinkUnlinked` (`src/ui/CalendarView.ts:930`) minus the modals:
  - recording start from frontmatter `date` (same logic as `ApiUnlinkedProvider.toUnlinked`, `ApiUnlinkedProvider.ts:142`)
  - `provider.fetchEvents(recordingDate, timezone)`; window filter with `settings.recordingWindowMinutes`; also fetch adjacent day when recording start is within the window of midnight
  - exclude all-day events and events whose notes already have a linked transcript (same filter as `CalendarView.ts:947`)
  - **1 candidate** → `noteCreator.createNote(event)` + `unlinkedProvider.linkToNote({...})` (exact arg shape at `CalendarView.ts:962-978`)
  - **N candidates** → LLM tiebreak: direct `spawnLlmPrompt` with `inlinePrompt` (pattern: `main.ts:920`) — "Read transcript at <path>. Candidate meetings: [{index, subject, start, organizer, attendees}]. Return ```json {"match_index": N|null}```". Short timeout (2 min). Parse fenced JSON; on failure/null/disabled-LLM → closest start time wins
  - **0 candidates** → unscheduled note named from transcript title (same `CalendarEvent` literal + `createNote(..., {preserveTimestamps, filenameOverride})` as `CalendarView.ts:991-1019`)
  - guards: in-flight `Set<string>` keyed by transcript path; `linkToNote` already renames the transcript to `"<note> - Transcript.md"` and sets `pipeline_state: titled`, which fires Stage B via the existing hook
- serialize all auto work through a promise-chain queue (pattern: `speakerTagModalQueue`, `main.ts:526`); when `activeLlmCount >= llmMaxConcurrent`, retry every 30s instead of dropping

### Modified: `src/main.ts`
- Instantiate + start `AutoPipeline`; recreate on settings change (folder/source may change)
- **Stage B trigger**: extend the existing `metadataCache.on("changed")` mirror listener (`main.ts:157-172`). When `pipeline_state === "titled"` and `settings.autoPipelineEnabled`: resolve meeting note; skip if `jobs.has("speakerTag", path)`, if `hasCachedProposals()` (means a previous auto run left stragglers — user judgment needed), or if already queued; else enqueue `doTagSpeakers(transcriptFile, fm, notePath, undefined, {auto: true})`
- `doTagSpeakers` (`main.ts:531`): add `opts?: {auto?: boolean}`. Auto mode skips the `CachedProposalModal` branch and threads `auto` to the success handler
- `handleSpeakerTagSuccess` (`main.ts:623`): in auto mode, instead of `presentSpeakerTagModal`, call new `autoApplySpeakerTags(mappings, ...)`:
  - confident = mappings with `proposedName` and confidence `CERTAIN`/`HIGH` → build `SpeakerTagDecision[]` directly (`{speakerId, originalName, confirmedName: proposedName, confidence, evidence}` — type at `src/ui/SpeakerTagModal.ts:6`)
  - **all speakers confident** → `applySpeakerTags` + word replacements + `updateFrontmatter(note, "tagged")` (same post-apply sequence as `main.ts:711-725`) → Stage C
  - **partial** → `applySpeakerTags(..., {setTaggedState: false, preserveUnappliedProposals: true})`; pipeline stays `titled`; cached proposals remain so the Speakers pill reopens the modal for stragglers (existing `CachedProposalModal` flow); card status "Speakers partially tagged — review needed" (warning); **no** auto-summary
  - **zero confident** → apply nothing, keep cached proposals, same review-needed status
- **Stage C**: after a full auto-tag, call `doSummarize(notePath, true)` when `autoPipelineEnabled` (independent of `autoSummarizeAfterTagging`, which keeps governing the manual-modal path)

### Modified: `src/services/SpeakerTagApplier.ts`
`applySpeakerTags` gains optional `opts: {setTaggedState?: boolean (default true); preserveUnappliedProposals?: boolean (default false)}` — partial mode skips `pipeline_state: tagged` and only deletes `proposed_name` for speakers actually applied (currently deletes all, `SpeakerTagApplier.ts:36`).

### Modified: `src/settings.ts`
- `autoPipelineEnabled: boolean` (default `false`) in `WhisperCalSettings` + `DEFAULT_SETTINGS`
- Toggle in the LLM section: "Automatic pipeline" — "Automatically link new transcripts to calendar meetings, tag speakers (confident matches only), and summarize. Requires LLM features." Disabled/hidden unless `llmEnabled`

### README.md
New "Automatic pipeline" section under LLM Integration: trigger conditions, the confidence rule, the partial-tag judgment-call escape hatch, and the 48h catch-up window.

## Edge cases & guards
- Watcher registered after `onLayoutReady` → no spurious creates from initial vault scan
- 20s settle delay + `meeting_note` re-check → no race with Record-pill `waitAndLink` (`src/services/ApiRecording.ts:225`)
- `hasCachedProposals` doubles as the "don't re-auto-tag" marker → no infinite titled-loop on partial results
- In-flight sets + `JobTracker` checks → no duplicate LLM runs; queue serializes so catch-up scans of several transcripts don't stampede `llmMaxConcurrent`
- LLM disabled or tiebreak fails → deterministic fallback (closest event), pipeline still completes link stage
- Auto-pipeline off → zero behavior change (all new code gated on the setting)

## Verification
1. `npm run build` && `npm run lint`
2. Deploy `main.js`, `manifest.json`, `styles.css` to `~/SDA/.obsidian/plugins/whisper-cal/`, reload Obsidian
3. Enable "Automatic pipeline"; copy a real Tome transcript `.md` (frontmatter intact, `date` near a cached calendar event) into the Transcripts folder → watch: auto-link → note created/linked → Speakers spinner → tags applied → summary written, `pipeline_state: summarized` on both files, no modals
4. Repeat with a `date` matching no event → unscheduled note auto-created, pipeline completes
5. Repeat with two back-to-back events in the window → LLM tiebreak picks by content (check console debug)
6. Record via the Record pill → after `waitAndLink` links the transcript, Stage B fires automatically (state-driven scope)
7. Doctor a transcript so the LLM returns LOW confidence → stays `titled`, "review needed" status, Speakers pill opens cached-proposal modal, applying there chains summary
8. Toggle off → drop another transcript → it lands in Unlinked section untouched
