# WhisperOrg integration — session handoff

**Saved:** 2026-07-11 (end of session) · **Resume:** next session
**Companion docs:** `WHISPERORG_INTEGRATION_PLAN.md` (the authoritative plan — §ref numbers below point into it), WhisperOrg `DESIGN.md` §16 (the API spec).

---

## TL;DR — where we are

The thread was about **people-insights**: WhisperCal's meeting summaries surface facts about people / relationships / orgs, and we want to propose those into **WhisperOrg** (the people system of record) for review.

Two things settled this session:

1. **Transport is fully unblocked.** WhisperOrg **M6 (public API v1) is now implemented and verified live** (commit `dee769a`). WhisperCal can call `api.propose("whispercal", items)` to push proposals into WhisperOrg's review inbox — with a direct file-drop as the fallback. (Details in "Verified state" below.)
2. **Pending decision:** *what to build first on the WhisperCal side.* We got to a 3-way choice (below) and the user paused to clarify before answering. **This is the resume point.**

---

## The pending decision (resume here)

**Question:** M6 is verified live — what to build next on the WhisperCal side?

| Option | Scope | Notes |
|---|---|---|
| **A. Insights vertical slice** *(was recommended)* | §5.1 OrgBridge + vendored types, §5.4 `OrgEnrichmentEmitter` (deterministic facts + LLM insights), §5.5 `orgEnrichment` setting | Shortest path to the feature this thread is about. Skips the §5.2 people-matching gateway refactor. |
| **B. Full plan order** | M0 → M2 → M3 → M4 → M5 (→M6) | Complete, matches the plan; insights land last. |
| **C. M0 only, now** | Just the ship-first migration-compat reads | Do this if the SDA vault migration is imminent. |

**User did not pick yet** — they wanted to clarify first. Open clarification threads I offered:

- **Scope boundaries** — whether an even narrower slice (LLM insights pass only, no deterministic email facts) makes sense.
- **The M0 hazard — does it apply right now?** ⇒ **KEY UNKNOWN: has WhisperOrg's all-people migration already run on the SDA vault, or is it imminent?** If imminent, M0 jumps the queue (see hazard below). Ask this first next session.
- **Presentation/review locus** — revisit "in-note insights callout vs WhisperOrg-inbox-only review" *before* building the emitter, since it changes what the emitter writes. (See "Presentation options" below.)

---

## Verified state — WhisperOrg M6 (do NOT re-verify from scratch)

Implemented and wired in the WhisperOrg repo (`/Users/dloomis/Projects/WhisperOrg`), commit `dee769a M6: public inter-plugin API v1`:

- **`src/api.ts`** — vendorable block lines **25–111**, `WHISPERORG_API_VERSION = 1`. Full surface: reads (`resolve` / `canonicalName` / `getPerson` / `listPeople` / `getConfig` — never throw, return `null`/`[]` before ready) + writes (`createPerson` / `propose` — error-prefix contract per plan §4.2). Compile-time drift guards vs `types.ts` at lines 114–115.
- **Actually exposed + ready** — `main.ts` (repo root, NOT `src/main.ts`): `this.api = createApi(this)` (line 65), `isApiReady()` (116–117), fires `whisperorg:ready` (line 126), `graph-changed` gated on readiness. So WhisperCal's `getWhisperOrgApi()` will get a live, ready object.
- **`propose("whispercal", items)`** — validates, writes `<inboxFolder>/YYYYMMDD-HHmmss-whispercal.json`, refreshes the review badge, **never applies** (review stays the only apply path), returns `{file, accepted, invalid[]}`.
- **Both schema-gap TODOs closed:** ORG-1 (`organization`→`company` alias, `constants.ts:155`) and ORG-2 (`^[a-z0-9]+_email$` extension emails now `field_update`-proposable, `constants.ts:118`; `isContractField` at 129).
- **`PLUGIN_API.md`** is generated on demand by the `write-contracts` command (main.ts:192), not committed — not a gap.

**WhisperCal side:** nothing built yet. No `OrgBridge`, no `src/types/whisperorg.ts` (only `whispercore.ts`). `CoreBridge.ts` is the byte-for-byte template for the future `OrgBridge`.

---

## Transport conclusion (settled)

`propose()` is **not a different destination** from the file-drop — it's the programmatic front door to the *same* review inbox, same JSON format, same validator, review-only. What the API adds over a raw file-drop: synchronous `{accepted, invalid[]}` feedback, live inbox path via `getConfig()`, badge refresh, stable error prefixes. There is deliberately **no** API method to apply a relationship/field/sentiment directly — the only immediate-apply write is `createPerson()`. **Recommended:** `propose()`-first, file-drop fallback (both produce the identical artifact, so the fallback is truly equivalent).

Payload = `OrgProposalItemInput[]`; always carry `confidence` (required), `evidence` (one sentence), `source_note` (meeting path), `observed` (date) so review works away from meeting context. Kinds available: `relationship` / `group_membership` / `manager` / `field_update` / `new_person` / `group_update` — these cover new fact on a person, new person, person↔person relationship, person↔org placement, reporting line.

---

## Presentation options (for the emitter — earlier brainstorm, not yet decided)

Spectrum cheapest→richest:
1. **Silent + toast** — emit, then a Notice "N insights sent to WhisperOrg for review" → click opens review. (Plan default.)
2. **In-note collapsed callout** — LLM writes `> [!question]- Proposed people insights` into the meeting note body, beside `## Summary`. Keeps insight next to evidence + gives a per-meeting audit trail. Does NOT violate the hard rule (that only forbids writing org-owned fields onto *People* notes; a meeting-note callout is descriptive). Optional: checkbox items that trigger `propose()` on tick.
3. **Confirmation modal** (SpeakerTagModal pattern) — pre-send triage in WhisperCal. Only worth it as a noise pre-filter (double-review otherwise).
4. **Card affordance** — "N insights" segment on `MeetingCard`.
5. **Confidence-tiered** — high-confidence deterministic facts auto-send (toast only); low-confidence judgment claims surfaced first.

Extraction fork (how insights get produced): (a) piggyback on summary prompt, (b) dedicated second LLM pass (plan's M5), (c) let the agentic summary LLM write proposal JSON straight into the inbox itself — genuinely cheap given the LLM already has file tools, at the cost of client-side validation/dedup control.

---

## When building (whichever option) — key refs & rules

- **Files to create for the slice (Option A):** `src/types/whisperorg.ts` (copy vendorable block verbatim from WhisperOrg `src/api.ts` lines 25–111 + header naming source + copy date), `src/services/OrgBridge.ts` (mirror `CoreBridge.ts`, retarget to `"whisperorg"` / `WHISPERORG_API_VERSION`), `src/services/OrgEnrichmentEmitter.ts` (§5.4), `orgEnrichment` setting (§5.5).
- **Hard rules (plan §6):** WhisperCal MUST NEVER write `member_of`/`manager`/`rel_*`/`## Relationships`/group notes; MUST NOT reach past `api` into `graph`/`relStore`/`inbox`; canonical identity = People-note basename (use `OrgPersonDto.basename`, never `fullName`); never cache the api object (fetch fresh via `OrgBridge` every call); every touchpoint must behave identically-or-better with WhisperOrg absent/disabled/not-ready/mismatched.
- **Consumer rules:** WhisperOrg `DESIGN.md` §16.9 (eight rules). `OrgBridge` = rules 1–3, 7.
- **M0 hazard (plan §2.3):** WhisperOrg's migration renames People-note frontmatter (`personnel_type`→`employment_type`, `company_email`→`work_email`, `nickname`→`aliases`, `company/org`→`company`). Once it runs on SDA, WhisperCal's `PeopleMatchService` matching / card icons / roster silently degrade. **M0 makes WhisperCal reads canonical-first with legacy fallback; must ship before that migration runs.**

---

## First actions next session

1. Ask: **has the SDA all-people migration run yet / is it imminent?** (decides whether M0 pre-empts.)
2. Confirm scope: Option A (insights slice) vs B (full order) vs C (M0 only).
3. (If A) decide the presentation/extraction forks above before writing `OrgEnrichmentEmitter`.
