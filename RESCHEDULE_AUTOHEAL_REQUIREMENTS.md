# Reschedule auto-heal — requirements

**Date:** 2026-07-15 · **Status:** REQUIREMENTS ONLY — design and implementation deferred to a dedicated session
**Audience:** An implementing LLM/developer. Style follows `WHISPERORG_INTEGRATION_PLAN.md`: intentionally over-specified; MUST/NEVER are hard requirements. Line references are as of WhisperCal 0.8.7, 2026-07-15 — re-verify before editing.

This states *what must be true*, not how. §7 lists the questions the design session must answer. **Do not implement from this document.**

---

## 1. Background — what already shipped

A meeting was rescheduled in Outlook (15:30 → 14:30, same Graph event id). The note and its transcript became reachable from **no card at all**:

- `NoteCreator.findNote()` matched the note's `calendar_event_id` against the event correctly, then vetoed the match because the note's stored `meeting_start` (15:30) no longer equalled the event's start (14:30).
- `CalendarView.findLocalNotes()` — the path that gives note-only cards a home — skips any note whose event id *is* in the calendar set, which it was.

Fixed 2026-07-15 in `src/ui/NoteCreator.ts` and `src/utils/time.ts`:

1. **`findNote` id-authoritative fallback.** A note matching on real event id + date but with a drifted `meeting_start` is collected as a rescheduled candidate; when **exactly one** note claims that id, it wins. Two or more ⇒ the ambiguity the time qualifier exists for is real, so leave unmatched rather than guess.
2. **`isRealEventId()` guard.** Ad hoc notes all carry the literal `"unscheduled"` sentinel. Without the guard, (1) would bind the *shared* unscheduled placeholder card to whichever ad hoc note happened to be the day's only one.
3. **`coerceFmDate` UTC fix.** YAML builds a bare `meeting_date: 2026-07-15` as midnight **UTC**; reading it with local getters returned `"2026-07-14"` in `America/New_York`. Callers compare against a `formatDate()` day key, so the match was silently lost.
4. **`startMatches` normalization.** It passed the raw `meeting_date` into `parseDateTime`, which calls `.match()` on it — a `TypeError` on a `Date`. Previously unreachable because the broken `===` short-circuited ahead of it; fix (3) made it reachable.

**What the fix does NOT do — the reason this document exists:** the card reconnects, but the bundle is left **stale**. The note is still named `2026-07-15 1530 - re Networking diagramming` and still says `meeting_start: 15:30`, while the meeting is at 14:30. The transcript, audio, and voiceprint sidecar all still carry `1530` in their filenames. Nothing corrects itself.

## 2. Goal

When a calendar event's time changes, bring the whole meeting bundle back into agreement with it — without ever destroying user intent.

## 3. Functional requirements

- **R1 — Detection.** A reschedule is: a note matched to an event by **real** `calendar_event_id` whose stored `meeting_start` / `meeting_end` / `meeting_date` disagree with that event. This is the condition `findNote` already computes internally as its rescheduled-candidate branch; the design SHOULD surface that decision rather than re-deriving it (see Q1).
- **R2 — Heal the note's frontmatter.** Update `meeting_date`, `meeting_start`, `meeting_end` to the event's values. Times MUST be written in the same format `NoteCreator` uses (`formatTime`, which honors the `timeFormat` setting — `data.json` currently `"24h"`), so healed notes are byte-comparable with freshly created ones.
- **R3 — Heal the transcript's frontmatter.** The transcript carries its **own copies** of `meeting_date` / `meeting_start` / `meeting_end` (written by the link path). They MUST be healed identically, or the note and transcript disagree about when the meeting was.
- **R4 — Rename the bundle in lock-step, but only when provably safe.** Rename the note and its related files **only** when the note's current basename is *exactly* the canonical basename the filename template would have produced for the **old** time + subject. If it differs, the user renamed it deliberately: heal frontmatter and **NEVER** rename. A custom note name MUST survive a reschedule untouched.
- **R5 — Reuse the existing rename machinery.** `renameMeetingFiles()` (`src/services/MeetingRenamer.ts`) + `collectMeetingRelatedFiles()` (`src/services/MeetingDeleter.ts`) already rename note + transcript + audio + sidecar in lock-step via `app.fileManager`, which rewrites every wiki-link vault-wide, and pre-checks collisions before touching anything. Do NOT write a second rename path.
- **R6 — Convergence.** Healing writes frontmatter, which fires `metadataCache.on("changed")`, which can re-trigger the render that detected the reschedule. The heal MUST be a no-op when there is no diff, and MUST be guarded against re-entrancy (`CalendarView.autoLinkInFlight` is the existing precedent). A heal loop that renames files on every tick is the worst plausible failure of this feature.
- **R7 — Ambiguity.** When two or more notes on a day claim the same event id, heal **nothing**. Same rule as the `findNote` fallback (§1.1); the design MUST NOT be more aggressive than the lookup it is built on.
- **R8 — Visibility.** Renaming moves files on disk. The user MUST be told (a `Notice` naming the meeting, consistent with the manual rename flow's `Renamed N files`). Frontmatter-only heals MAY be silent.

## 4. Safety requirements (things that MUST NOT happen)

- **R9 — Never heal ad hoc notes.** They are structurally immune and healing them is *incoherent*: `findLocalNotes` derives the synthetic card's `startTime` **from the note's own** `meeting_start`, so the value round-trips and can never drift. The note is the source of truth; there is no external time to reconcile against. Gate on `isRealEventId()`.
- **R10 — Never clobber a user's chosen filename** (R4). This is the requirement most likely to be quietly violated by a "just re-derive the canonical name" implementation.
- **R11 — Leave `source_file` and `voiceprints` alone.** These transcript frontmatter fields are plain strings (not wiki-links), so `fileManager` will not rewrite them and they WILL go stale after a rename. That is **acceptable and intended**: both artifacts have convention-based resolution fallbacks that hold after a lock-step rename — `resolveTranscriptAudio` falls back to `<transcript basename>.m4a`, `resolveVoiceprintSidecar` falls back to `<transcript path>.voiceprints.json`. `source_file` is *Tome's own record of what it produced*; rewriting it would falsify history. Verify these fallbacks still exist before relying on this.
- **R12 — Do not fight the YAML round-trip.** Healing via `processFrontMatter` (i.e. `batchUpdateFrontmatter`, which also serializes per-file writes — use it) re-emits the whole block and will strip quotes, turning `meeting_date: "2026-07-15"` into a bare date that re-reads as a **`Date` object**. This is already what happens in the vault today and is why `coerceFmDate` exists. Do not add a bespoke line-surgery writer to avoid it; DO make sure every new read path normalizes. (`MeetingImporter` uses line surgery deliberately — that is a different problem, imported bundles, and is not precedent here.)

## 5. Known gap — cross-day reschedules (NOT covered by the shipped fix)

Verified 2026-07-15 by running the real `findNote` against the real vault:

```
same-day  reschedule (15:30 -> 14:30) -> resolves the note
cross-day reschedule (-> Jul 16)      -> NULL (orphan)
```

Every match branch in `findNote` is **gated on `fmDate === date`**, so moving a meeting to a *different day* fails to match at all — the rescheduled-candidate fallback never even collects it.

The resulting behavior is worse than a plain orphan, and the design session MUST decide what to do about it:

- On the **old** day, the event is gone from the calendar, so `calendarEventIds` no longer contains its id and `findLocalNotes` **gives the note its own local card** — a ghost card for a meeting that has moved away.
- On the **new** day, the event's card finds no note and offers **"Create note"** — inviting a duplicate note for a meeting that already has one, with the transcript still attached to the ghost.

- **R13.** Cross-day reschedules MUST reach a defined outcome. Whether that is "heal across days" (drop the date gate for the id-match branch, and move the date prefix in the filename) or "detect and warn" is a design decision (Q3) — but silently producing a ghost card plus a duplicate-note invitation is not acceptable.

## 6. Non-goals

- **Not a `meeting_uid` prerequisite, and not blocked on it.** See `WHISPERORG_INTEGRATION_PLAN.md` §11 (M7). The two are complementary: M7 fixes *identity*, this fixes *staleness*. A uid would not heal a stale filename, and healing does not give ad hoc bundles an identity. **Neither substitutes for the other** — do not merge these milestones.
- Not a general "sync the note to the calendar" feature. Subject, attendees, location, and body changes are explicitly out of scope; **time only**. (Q4 revisits subject.)
- Not a fix for a *cancelled* or *deleted* event — different problem, different outcome.

## 7. Open questions for the design session

- **Q1 — Where does detection live?** `findNote` already computes "matched by id but time drifted" and throws that information away at the return. Options: widen it to return match metadata (e.g. `findNoteMatch(event): {file, rescheduled} | null`, with `findNote` delegating so its ~8 existing call sites are untouched), or detect separately in the heal pass and accept the duplicated scan. Prefer not to duplicate the heuristic — it is exactly the pile this codebase keeps getting bitten by.
- **Q2 — When does the heal run?** `CalendarView.renderEvents()` is **synchronous** and must not perform vault writes. The async load path around `CalendarView.ts:372-388` (post-`fetchEvents`, pre-`renderEvents`) is the natural seam, and `autoLinkObvious()` is the precedent to copy — including its `autoLinkInFlight` guard and its `refreshGeneration` abort check. Decide: heal before render (card renders correct immediately, costs latency) or fire-and-forget after (renders stale once, self-corrects).
- **Q3 — Cross-day policy** (§5, R13). Heal across days, or detect-and-warn? Note that dropping the `fmDate === date` gate widens the id-match branch's blast radius — re-check the recurring-series concern the time qualifier was originally added for (`findNote`'s comment: Graph can return the same `id` for different occurrences).
- **Q4 — Does subject drift heal too?** A renamed calendar event drifts the note's `meeting_subject` and canonical filename the same way a time change does. Same machinery, strictly more risk (R10 collides hard). In or out?
- **Q5 — Opt-in?** Auto-renaming files without asking is the sharpest edge here. Options: always-on (simplest, matches the request), a setting, or a confirm modal. Note the existing preference to **repurpose an existing setting as a mode switch rather than add a toggle** — check whether one fits before adding a new one.
- **Q6 — Backfill.** Notes already stale from past reschedules (at minimum `2026-07-15 1530 - re Networking diagramming` in the SDA vault) will not heal until their event is re-fetched and re-rendered on that day. Is a one-shot repair command warranted, or do they heal opportunistically / get fixed by hand?

## 8. Acceptance (sketch — the design session refines this)

The 2026-07-15 SDA-vault case is the canonical fixture:

- Note `6 Meeting Summaries/2026-07-15 1530 - re Networking diagramming.md`, event id `…AAQ7I7PBAAA=`, event now `18:30Z` (14:30 EDT), note says `15:30`.
- After heal: note + transcript + `.m4a` + `.voiceprints.json` all named `…1430…`; `meeting_start: "14:30"`, `meeting_end: "15:00"` on **both** note and transcript; the card resolves; the transcript is still linked; the voiceprint sidecar still resolves; `pipeline_state` unchanged (`titled`).
- Regression fixtures that MUST NOT change: a note with a custom name (R4/R10), an ad hoc note (R9), a day with two notes claiming one event id (R7), an unmoved meeting.
- A harness that runs the **real** `findNote` against the real vault (fake `App` + `js-yaml`-parsed frontmatter, esbuild-bundled with an `obsidian` alias stub) was used to verify the shipped fix and the §5 gap. Rebuild it; two of its own early revisions were themselves broken (`instanceof` mismatch across bundles; stub `TFile` missing `.extension`, which silently skipped the entire frontmatter scan while making unmoved events still *look* fine via the canonical fast path). Assert on a **failing** case before trusting a passing one.
