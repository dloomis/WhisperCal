# WhisperCal ⇄ WhisperOrg — Integration Implementation Plan

**Version:** 1.0 · **Date:** 2026-07-11 · **Status:** READY FOR IMPLEMENTATION — open questions resolved as decisions (§9); the Part A API spec is authoritative in WhisperOrg `DESIGN.md` §16 (landed 2026-07-11), summarized here in §4
**Audience:** An implementing LLM/developer. Written in the style of WhisperOrg's `DESIGN.md`: intentionally over-specified; MUST/NEVER are hard requirements. Line numbers reference the code as of 2026-07-10 (WhisperCal 0.8.7 @ `2009ddb`, WhisperOrg 0.1.0 @ `b2461e4`) — re-verify before editing.

**Repos:** WhisperCal `/Users/dloomis/Projects/WhisperCal` (plugin id `whisper-cal`, desktop-only) · WhisperOrg `/Users/dloomis/Projects/WhisperOrg` (plugin id `whisperorg`, cross-platform, feature-complete v0.1.0 per its `DESIGN.md` M0–M5).

---

## 0. Purpose & product vision

WhisperCal is the **producer**: it sees calendar attendees (name + email from Graph/Google), confirmed speakers, transcripts, and summaries. WhisperOrg is the **people system of record**: canonical person schema, org groups, typed relationships, an in-memory `OrgGraph` with a name resolver, and a reviewed enrichment inbox.

After this integration:

1. WhisperCal **stops owning people identity**. Attendee→person matching, canonical-name resolution (the voiceprint seam), and person-note creation all route through WhisperOrg when it is installed and enabled.
2. WhisperCal becomes WhisperOrg's **richest enrichment producer**: meeting-derived facts (emails, org placement, relationships, sentiment) flow into the reviewed inbox instead of being lost or silently written.
3. WhisperCal **degrades gracefully**: with WhisperOrg absent or disabled, every current behavior keeps working exactly as today. WhisperOrg never learns about WhisperCal (it already treats WhisperCal as "one optional producer" — that stays true).

Directionality rule: **WhisperCal knows about WhisperOrg; WhisperOrg MUST NOT import, reference, or special-case WhisperCal** beyond its existing generic producer contract. All WhisperOrg-side changes in Part A are generic capabilities any consumer could use.

---

## 1. Architecture decision: two channels, not one

WhisperOrg's spec'd integration surface is the **file-based Inbox** (`_WhisperOrg/Inbox/*.json`, six proposal kinds, human review). That design is right for what it does — but it cannot serve WhisperCal's synchronous needs, and forcing everything through it would be wrong. Analysis:

### 1.1 What the Inbox cannot do

WhisperCal needs answers **at interaction time**:

- **Meeting-note creation** (`NoteCreator.buildNoteContent`): attendee emails → People-note basenames for `meeting_invitees` wiki-links. Needs an answer in milliseconds, not after review.
- **Voiceprint enrollment** (`VoiceprintEnroller`): confirmed speaker name → canonical People-note basename, *before* the library file `<voiceprintFolder>/<canonicalName>.json` is written. The invariant "canonical identity = People-note basename" is load-bearing; an async answer desyncs libraries.
- **Speaker-confirmed person creation** (`main.ts` post-tag flow): a newly confirmed speaker MUST have a note *now* so enrollment aligns. A `new_person` proposal awaiting review would break the chain.

### 1.2 What a direct API cannot replace

Judgment-laden claims (LLM-inferred relationships, org placement, sentiment, field corrections) **must stay behind review** — that is WhisperOrg's core safety property (its DESIGN §7: "Producers never edit WhisperOrg-owned fields directly"). WhisperCal MUST NOT get a bypass.

### 1.3 Decision

| Channel | Used for | Mechanism |
|---|---|---|
| **A. Versioned public API** (new, Part A) | Synchronous, deterministic, low-risk: resolve, canonicalName, read person info, create person note, submit proposals programmatically | `app.plugins.getPlugin("whisperorg").api`, feature-detected at call time |
| **B. Enrichment Inbox** (exists) | Asynchronous, judgment-laden: relationships, org placement, manager claims, field updates, sentiment | JSON proposal files, via `api.propose()` when the API is present, else direct file write per `ENRICHMENT_CONTRACT.md` |

### 1.4 Alternatives considered and rejected

- **Pure Inbox** (status quo spec): fails §1.1. Rejected.
- **Pure API, no Inbox**: loses review safety, loses the works-while-plugin-disabled property, and duplicates the already-implemented, already-tested apply pipeline. Rejected.
- **Shared npm types package** (`@dloomis/whisperorg-api`): correct at ecosystem scale, overkill for two sibling repos with one author — and the ecosystem precedent argues against it: Dataview's published npm typings have been broken for 2.5+ years (path-alias imports survive into the `.d.ts`, types degrade to `any`; [issue #2209](https://github.com/blacksmithgu/obsidian-dataview/issues/2209)). WhisperCal instead vendors the dependency-free "vendorable block" from WhisperOrg `src/api.ts` (§5.1); drift is caught by the runtime `apiVersion` check. Revisit if a third consumer appears.
- **WhisperOrg depends on WhisperCal** (e.g. WhisperOrg pulls meeting data): violates the standalone-plugin principle and the stated product direction. Rejected.
- **Global namespace export** (`window.WhisperOrgAPI`): the community-known alternative to the plugins registry; adds a global with no benefit over `getPlugin()` here. Rejected.

### 1.5 Lifecycle & load-order rules (both parts)

- `app.plugins` is **not in Obsidian's public typed API** (community-standard but unofficial). WhisperCal adds an ambient declaration (§5.1) and MUST treat every access as fallible.
- WhisperCal MUST fetch the API **lazily at each call site** (via one helper) and MUST NOT cache the api object across awaits or store it long-lived. This makes load order, enable/disable at runtime, and plugin updates all self-healing — no `onLayoutReady` handshake needed.
- WhisperOrg's graph builds on `onLayoutReady` → `graph.build()`. Before that, API reads MUST be safe (§4.1 `isReady()`); WhisperCal treats not-ready as "WhisperOrg absent" and falls back.
- Cross-bundle object identity: the API MUST exchange **plain JSON DTOs only** — never `TFile`, never internal `Person` objects, never class instances (no `instanceof` across bundles).
- These rules are formalized as the eight normative consumer rules in WhisperOrg `DESIGN.md` §16.9 (rendered into WhisperOrg's generated `PLUGIN_API.md`). WhisperCal MUST comply with all eight. Note on rule 3 (boolean-first readiness): WhisperCal satisfies it without ever listening for `whisperorg:ready` — the lazy per-call `isReady()` gate plus the always-alive legacy fallback IS the boolean-first pattern; there is nothing to wait for.

---

## 2. Current state (facts the plan builds on)

### 2.1 WhisperCal people surface (survey 2026-07-10)

- **`src/services/PeopleMatchService.ts`** — the identity service. Rebuilds an index of the People folder per call. Public: `matchAttendees`, `matchOne`, `matchOneInfo`, `canonicalName`, `buildRoster`. Match order: exact email → exact name → parsed name → digit-suffix-stripped name; also derives `first.last@` name variants from email local-parts. Frontmatter read: `full_name`, `nickname`, `role_title`, `personnel_type`, `organization` (fallback `company`), emails `company_email`, `personal_email`, `sipr_email`, `nipr_email`, `preferred_email`.
- **Call sites:** `NoteCreator.ts:230-232` (attendee/organizer matching), `main.ts:816-822` (`buildRoster` for the tagging LLM), `main.ts:1296-1304` (`canonicalizeProposals`), `VoiceprintEnroller.ts:237` (`canonicalName` — the voiceprint seam), `CalendarView.ts:662-668` → `MeetingCard.ts:570-571` (`matchOneInfo` for the organizer row), `PeopleAutoCreate.ts` (dedup).
- **Person-note creation (3 sites):** `PeopleAutoCreate.autoCreatePeopleNotes` (organizer sweep, setting-gated, template required); `PeopleAutoCreate.createPeopleNotesForNames` (confirmed speakers, always-on, minimal `full_name` stub fallback); `SpeakerTagModal.createPersonNote` (manual "+ Create note", minimal stub).
- **Voiceprint invariant:** library file name and `library.name` = canonical People-note basename (`VoiceprintEnroller.ts:234-236`).
- **Wiring idioms:** deps-object constructor injection (`AutoSpeakerTagger`, `main.ts:143-151`) for stateful services; module-level `(app, paths…)` functions (`PeopleAutoCreate`, `VoiceprintEnroller`) for stateless ones; `PeopleMatchService` is `new`'d per use.
- **Settings:** `peopleFolderPath`, `autoCreatePeopleNotes`, `peopleTemplatePath`, `microphoneUser`, `rosterMaxEnriched`, voiceprint settings, `importantOrganizers`.

### 2.2 WhisperOrg surface

- Plugin class exposes `graph: OrgGraph`, `relStore: RelationshipStore`, `inbox: Inbox` as public fields — but **no deliberate, versioned API**. That is the gap Part A closes. Consumers MUST NOT touch `graph`/`relStore`/`inbox` directly (they exchange internal types and can change shape freely).
- `resolvePerson(graph, input)` (`src/graph/resolve.ts`) resolves wikilink → basename → `full_name` → aliases → `handle_*`. **It does not resolve emails** — WhisperCal matches primarily by email, so Part A adds an email index.
- `createPersonNote(app, settings, fullName)` (`src/io/create.ts`) — canonical template, guarantees `type: person` + `full_name`. **No way to seed other fields** (emails, company) at creation. Part A adds that.
- Inbox: filename `YYYYMMDD-HHmmss-<source>.json`, kinds `relationship | group_membership | manager | field_update | new_person | group_update`, validation in `src/enrich/schema.ts`, `field_update` allowlist = canonical core fields + `handle_*`.
- Field aliases (read-bridge): `company←company/org`, `work_email←company_email`, `employment_type←personnel_type`, `aliases←nickname`, `manager←reports_to`, `handle_mattermost←mattermost_username`.
- Settings that matter to WhisperCal: `peopleFolder`, `pluginFolder` (inbox lives at `<pluginFolder>/Inbox`), `fieldAliases`.

### 2.3 ⚠ The migration hazard (why M0 exists)

WhisperOrg's vault migration **renames frontmatter keys on People notes that WhisperCal reads today**: `personnel_type`→`employment_type`, `company_email`→`work_email`, `nickname`→merged into `aliases`, `company/org`→`company`. After the all-people migration runs on the SDA vault:

- `PeopleMatchService` email matching loses `company_email` hits → attendee matching quietly degrades.
- `PersonInfo.personnelType` comes back empty → `MeetingCard` personnel-type icons disappear.
- `nickname` lookups and the roster's Nickname column go empty.

**This breaks with or without any integration.** M0 (§7) fixes WhisperCal's *reads* to be canonical-first with legacy fallback, mirroring WhisperOrg's own alias map. M0 MUST ship (deployed to the vault) before the all-people migration runs.

### 2.4 Field-coverage audit: what WhisperCal expects vs what WhisperOrg implements

Every People-note frontmatter field WhisperCal reads or writes, and whether WhisperOrg's canonical schema + alias map actually implements it (regardless of name):

| WhisperCal field | Where used | WhisperOrg status | Disposition |
|---|---|---|---|
| `full_name` | matching, creation stub | ✅ core | none |
| `nickname` | matching, roster, template var | ✅ via `aliases` (+ alias map) | M0 reads `aliases` first |
| `role_title` | `PersonInfo`, roster | ✅ core | none |
| `organization` (fallback `company`) | `PersonInfo`, card, template var | ⚠ `company` is core, but **`organization` is NOT in WhisperOrg's default `fieldAliases`** (only `company/org` is) — notes written by WhisperCal templates with an `organization:` key are invisible to WhisperOrg | **TODO-ORG-1** (DESIGN.md §16.10) |
| `personnel_type` | `PersonInfo`, card icon | ✅ via `employment_type` (+ alias map) | M0 reads canonical first |
| `company_email` | email matching | ✅ via `work_email` (+ alias map) | M0 adds `work_email` |
| `personal_email`, `preferred_email` | email matching | ✅ core | none |
| `sipr_email`, `nipr_email` | email matching | ⚠ extension fields: findable once the DESIGN.md §16.5 `/_email$/` index lands, but **not proposable** — the `field_update` allowlist rejects them, so WhisperCal could never propose filling one in | **TODO-ORG-2** (DESIGN.md §16.10) |

**Standing gap protocol (applies to every milestone):** whenever implementation discovers WhisperCal expecting a People-note frontmatter capability that WhisperOrg does not implement — under any name — the fix is a **TODO work item against WhisperOrg** (appended to the DESIGN.md §16.10 TODO list and, when it changes the data model, to the relevant DESIGN.md section), NEVER a WhisperCal-side workaround that reads/writes around the schema. WhisperOrg owns the person schema; WhisperCal adapts to it or files the gap.

---

## 3. Data-flow walkthroughs (target state)

### 3.1 Meeting note creation
1. `NoteCreator.buildNoteContent` asks the **PeopleGateway** (§5.2) to match attendees/organizer.
2. Gateway: WhisperOrg present+ready → `api.resolve({name, email})` per attendee (email wins); miss or ambiguous → legacy `PeopleMatchService` fallback; WhisperOrg absent → legacy only.
3. Wiki-links land in `meeting_invitees` exactly as today (basenames). No behavior change visible when results agree; WhisperOrg adds alias/handle-based hits legacy matching misses.

### 3.2 Speaker tagging & enrollment
1. Roster (`buildRoster`) enriched via gateway; when WhisperOrg answers, add org placement (primary group) to the Context column — better LLM disambiguation for free.
2. Modal confirm → `canonicalizeProposals` and `VoiceprintEnroller.canon()` call `gateway.canonicalName()` (org-first, legacy fallback). Invariant preserved: result is always a People-note basename.
3. Genuinely new confirmed speaker → `gateway.createPerson({fullName, source: "speaker"})` → WhisperOrg canonical template (fallback: today's stub). Note exists synchronously; enrollment proceeds.
4. Ambiguous resolution (two "Erik Elkington*" notes): gateway treats as unmatched, keeps the typed name, logs once — NEVER auto-picks.

### 3.3 Post-summary enrichment (new feature, M4/M5)
1. Summary pipeline completes → `OrgEnrichmentEmitter` (new service) runs if enabled.
2. Deterministic items (M4): observed attendee email not on the matched person's note → `field_update` (`work_email`/`preferred_email`); unmatched real-person attendees → `new_person` with `fields: {work_email, company}` (company from email domain, reusing `deriveOrg` logic).
3. LLM items (M5): a dedicated prompt over transcript+summary emits relationship/sentiment/org claims → validated → proposal items with `confidence`, `evidence`, `source_note` (the meeting note path), `observed` (meeting date).
4. Emission: `api.propose("whispercal", items)` when API present; else write the JSON file directly to `<pluginFolder>/Inbox/` per contract. User reviews in WhisperOrg's modal; WhisperCal never touches `member_of`/`manager`/`rel_*` directly. **Hard rule preserved.**

---

## 4. Part A — WhisperOrg public API v1 (spec landed; summary only)

> **The authoritative Part A spec is WhisperOrg `DESIGN.md` §16 "Public API v1"** (landed 2026-07-11, refined against the Dataview external-API research; implemented as WhisperOrg milestone **M6**, Opus high, with its own nine-point acceptance checklist in §16.12). This plan deliberately no longer duplicates the interface — duplication drifts, and Part A sessions run in the WhisperOrg repo with DESIGN.md in context. This section keeps only what Part B consumes. If this summary and DESIGN.md §16 ever disagree, §16 wins.

### 4.1 What Part B gets (summary — full definitions in DESIGN.md §16.3)

- `plugin.api: WhisperOrgApi` as a public field on the plugin instance; `apiVersion === 1`; `isReady()` persistent boolean (false until the graph builds on `onLayoutReady`).
- **Reads** (synchronous, never throw; `null`/`[]` when not ready): `resolve(query)` → `{match, ambiguous}` (string or `{name?, email?}`; email tried first), `canonicalName(query)` → basename or null (the voiceprint seam), `getPerson(query)`, `listPeople()` (snapshot — never poll; re-query on `whisperorg:graph-changed`), `getConfig()` → `{peopleFolder, groupsFolder, inboxFolder}` (live, resolved vault-relative paths). Email lookups hit a dedicated index that includes every `/_email$/` extension field (`sipr_email`, `nipr_email`) — DESIGN.md §16.5.
- **Writes** (async, throw `Error` with stable prefixes, §4.2 below): `createPerson({fullName, fields?})` → `{path, basename}` — the returned ref is authoritative; callers MUST use it and never re-resolve (graph updates async after create). `propose(source, items)` → `{file, accepted, invalid}` — validates, writes the inbox file, refreshes the badge; NEVER applies (review stays the only apply path); invalid items are still written and reported back.
- **Events** on `app.workspace` (both `registerEvent`-compatible, both courtesy — no API method requires them): `whisperorg:ready` (one-shot per load; re-fires on disable→re-enable), `whisperorg:graph-changed` (debounced 500 ms, no payload — consumers re-query).
- **DTOs** are plain JSON: `OrgPersonDto` (`path`, `basename`, `fullName`, `aliases`, `roleTitle?`, `company?`, `employmentType?`, `emails {preferred?, work?, personal?, other[]}`, `handles`, `memberOf` ([0] = primary), `primaryGroupName?`, `manager?`) and `OrgProposalItemInput` (ProposalItem minus `decision`). Both are declared in a dependency-free, marker-delimited **vendorable block** in WhisperOrg `src/api.ts`, designed for verbatim hand-copying (§5.1).
- WhisperOrg generates `_WhisperOrg/PLUGIN_API.md` (access snippet, readiness pattern, the eight consumer rules of DESIGN.md §16.9) via its `write-contracts` command.
- Schema-gap fixes **TODO-ORG-1** (`organization` → `company` field alias) and **TODO-ORG-2** (`^[a-z0-9]+_email$` proposable) land with the same milestone (DESIGN.md §16.10).

### 4.2 Error contract Part B must handle

Reads never throw. Writes throw `Error` with stable, prefix-matched messages:

| prefix | thrown by | WhisperCal handling |
|---|---|---|
| `WhisperOrg API: not ready` | createPerson/propose | unreachable while `OrgBridge` gates on `isReady()`; if it ever surfaces, treat as absent |
| `WhisperOrg API: note already exists — <path>` | createPerson | resolve-first contract violated, or a create race; log + fall back to the legacy creation path |
| `WhisperOrg API: field not in contract — <key>` | createPerson | a WhisperCal bug (bad field mapping); log loudly + fall back |
| `WhisperOrg API: invalid source — <source>` | propose | a WhisperCal bug (`"whispercal"` is valid); log loudly + fall back to the file write |

Blanket rule: any throw from an API write → one console warning + take the legacy/fallback path. Never crash the pipeline, never retry in a loop, never show the raw error to the user.

---

## 5. Part B — WhisperCal changes

> Conventions per WhisperCal `CLAUDE.md`: strict TS, imperative DOM, `whisper-cal-` CSS prefix, sentence-case UI strings. Version bumps are patch by default.

### 5.1 Vendored types + bridge — `src/types/whisperorg.ts`, `src/services/OrgBridge.ts`

- `src/types/whisperorg.ts`: a **verbatim hand-copy of the vendorable block** from `../WhisperOrg/src/api.ts` — everything between the `// ── consumer-facing types (vendorable) — keep dependency-free ──` and `// ── end vendorable block ──` markers, markers included, plus a header comment naming the source file and the copy date. The block is dependency-free by contract (WhisperOrg DESIGN.md §16.2), so it compiles standalone. No import, no npm link. Re-copy whenever WhisperOrg bumps `WHISPERORG_API_VERSION`; the runtime `apiVersion` check is the drift alarm.
- Ambient augmentation (same file or `src/types/obsidian-internals.d.ts`):

```ts
declare module "obsidian" {
	interface App {
		plugins: {
			getPlugin(id: string): Plugin | null;
			enabledPlugins: Set<string>;
		};
	}
}
```

- `OrgBridge.ts` — one stateless helper, the **only** place that touches the registry:

```ts
export function getWhisperOrgApi(app: App): WhisperOrgApi | null {
	const plugin = app.plugins?.getPlugin?.("whisperorg") as { api?: WhisperOrgApi } | null;
	const api = plugin?.api;
	if (!api || api.apiVersion !== 1 || !api.isReady()) return null;
	return api;
}
```

Called fresh at every use (§1.5). If `apiVersion` mismatches, log a one-time console warning naming both versions. This helper is WhisperCal's implementation of consumer rules 1–3 and 7 (DESIGN.md §16.9): fetch-fresh/never-cache, exact version check, boolean-first readiness (the legacy fallback replaces waiting on `whisperorg:ready`), and absent ≡ disabled ≡ not-ready ≡ mismatched. The only event WhisperCal ever subscribes to is the optional `whisperorg:graph-changed` listener in M6 — via `this.registerEvent(app.workspace.on("whisperorg:graph-changed" as never, …))` (the `as never` cast is required: Obsidian types `workspace.on` against its known event-name union).

### 5.2 PeopleGateway facade — `src/services/PeopleGateway.ts`

A class with `PeopleMatchService`'s exact public surface (`matchAttendees`, `matchOne`, `matchOneInfo`, `canonicalName`, `buildRoster`), constructed `new PeopleGateway(app, peopleFolderPath)` so it is a drop-in at every call site.

Resolution policy (each public method):
1. `getWhisperOrgApi()` → if non-null, query WhisperOrg (`resolve({name, email})`; email precedence preserved).
2. Org `match` → map `OrgPersonDto` → the legacy return shape (`PersonInfo`: `personnelType ← employmentType`, `organization ← company`, `nickname ← aliases[0]`, `roleTitle`, `notePath ← path` sans `.md`).
3. Org `ambiguous` → treat as unmatched (log once per name per session), fall through.
4. Org miss, or WhisperOrg absent/not-ready → delegate to a lazily-created legacy `PeopleMatchService` (unchanged, kept as-is).

`buildRoster` additionally appends `· <primaryGroupName>` to the Context column when WhisperOrg supplied the person. Everything else about the roster format is unchanged (the tagging prompt is tuned to it).

**Call-site migration** (mechanical; `new PeopleMatchService(` → `new PeopleGateway(`):

| Site | Today |
|---|---|
| `NoteCreator.ts:230` | attendee/organizer matching |
| `main.ts:816` | roster build |
| `main.ts:1296` | `canonicalizeProposals` |
| `VoiceprintEnroller.ts:237` (`canon()`) | **voiceprint seam** — via the gateway instance passed in / constructed there |
| `CalendarView.ts:662-668` | memoized instance for `MeetingCard` |
| `PeopleAutoCreate.ts` (both fns) | dedup lookups |

`PeopleMatchService` itself is NOT deleted — it is the fallback engine (and gets M0's alias fixes).

### 5.3 Creation delegation

All three creation sites route through one new function in `PeopleAutoCreate.ts`:

```ts
/** Create a person note — through WhisperOrg's canonical template when available,
 *  else the existing local path. Returns the basename actually created. */
export async function createPersonViaOrg(
	app: App, settings: WhisperCalSettings,
	input: { fullName: string; email?: string; organization?: string }
): Promise<string | null>
```

- WhisperOrg present: `api.createPerson({fullName, fields})` with `fields` mapped to **canonical keys**: `work_email` (from email), `company` (from `organization`/`deriveOrg`), `preferred_email` when it is the only email. Use the returned `basename` directly (do not re-resolve — graph updates async). Wrap the call per the §4.2 error contract: on any throw, log one console warning and fall back to the legacy creation path below — creation must never fail outright because the API refused.
- Absent: current behavior byte-for-byte (organizer sweep keeps requiring `peopleTemplatePath`; speaker/manual paths keep the minimal stub).
- Call sites: `autoCreatePeopleNotes` (organizer sweep), `createPeopleNotesForNames` (confirmed speakers), `SpeakerTagModal.createPersonNote` (manual). The `isLikelyPerson`, surname-collision, and `microphoneUser` guards stay exactly where they are — they are WhisperCal product logic, not identity logic.
- The auto-created info callout (`> [!info] Auto-created…`) is appended by WhisperCal after creation in the organizer-sweep path only, as today.

### 5.4 Enrichment emission — `src/services/OrgEnrichmentEmitter.ts` (new)

Runs fire-and-forget after summary completion (hook next to the existing post-summary steps in `main.ts`), and only when `orgEnrichment !== "off"` and the inbox is reachable.

**Deterministic pass (M4):**
- For each matched invitee whose note lacks the observed email (per `matchOneInfo`/DTO): `field_update` `{field: work_email | preferred_email, value, confidence: 0.95, evidence: "Attendee address on <meeting subject>", source_note, observed}`. Personal-looking domains (gmail/outlook/icloud…) → `personal_email`; never guess `preferred_email` unless the note has no email at all.
- For each unmatched attendee passing `isLikelyPerson`: `new_person` `{full_name, fields: {work_email, company}, confidence: 0.8}`.
- Dedup memory: keep a `Set` of emitted item keys (`kind|subject|field|value`) in the plugin's `data.json` (small, capped at 500 entries LRU) so recurring meetings don't re-propose the same fact every week; WhisperOrg's own dedupe is the backstop, not the primary guard.

**LLM pass (M5):**
- New prompt file `org-enrichment.md` installed by the existing `PromptInstaller` (vault prompt files are the source of truth — copy vault → repo, never reverse). Input: transcript + summary + the matched-people roster. Output: strict JSON array of proposal items limited to kinds `relationship | manager | group_membership | field_update`, with `confidence`, one-sentence `evidence`, `observed` = meeting date. Per decision D4 (§9), `relationship` items are further limited to the launch subset `works_with | positive_about | negative_about | mentor_of` — the prompt lists only these, and the client-side validator rejects any other type (one shared constant; widening later = prompt + constant, no schema change).
- Runs through `LlmInvoker` under the same `llmMaxConcurrent` cap with a distinct job set in `src/state.ts` (so UI can show it), parsed defensively (reject the whole batch on malformed JSON; log to the existing llmErrorLog).
- Client-side pre-validation before `propose()`: taxonomy regex, confidence range, subject must resolve or be a confirmed speaker name. Items referencing the `microphoneUser` as subject are allowed (their relationships are the most observable ones).
- Emission via `api.propose("whispercal", items)`; fallback = write the file to `<inboxFolder>` (path from `api.getConfig()` when available, else new setting `orgInboxPath`, default `_WhisperOrg/Inbox`). A `propose()` throw also falls back to the direct file write per the §4.2 blanket rule. If neither the API nor the folder exists → skip silently (WhisperOrg not adopted in this vault).

### 5.5 Settings & UI

Minimal footprint (prefer mode switches over toggle sprawl):

- **No setting for lookup/creation delegation.** Presence of WhisperOrg is the switch: auto-detected, always preferred, silent fallback. (If refinement decides an escape hatch is needed, make it a hidden `data.json` key, not UI.)
- **One new setting:** `orgEnrichment: "off" | "facts" | "facts+llm"` (default `"off"` initially; flip default to `"facts"` after it has soaked). Rendered as a dropdown in the existing People settings section with a description linking the WhisperOrg review flow.
- Settings People section: when WhisperOrg is detected, show a passive status line ("WhisperOrg detected — people matching and creation are delegated"), plus a **mismatch warning** if `api.getConfig().peopleFolder !== settings.peopleFolderPath` (this misconfiguration would silently split identity between two folders — warn loudly, don't auto-fix).
- `MeetingCard` organizer row: unchanged mechanics; it just gets richer `PersonInfo` through the gateway (icon keeps working post-migration thanks to the `employmentType` mapping).

### 5.6 Docs

Update WhisperCal `CLAUDE.md` (Key Layers + a short "WhisperOrg integration" paragraph: two channels, gateway, hard rule about never writing org-owned fields) and README. Add the same hard-rules block to `OrgBridge.ts` header comments.

---

## 6. Hard rules (both repos — violations are bugs)

1. WhisperCal MUST NEVER write `member_of`, `manager`, `rel_*`, `## Relationships`, or group notes — not even when WhisperOrg is absent. Claims about those go to the Inbox or nowhere.
2. WhisperCal MUST NOT reach past `api` into `plugin.graph` / `relStore` / `inbox`.
3. Canonical identity stays **People-note basename** end-to-end; any code path that produces a "canonical name" from WhisperOrg MUST use `OrgPersonDto.basename` (or `createPerson().basename`), never `fullName`.
4. Ambiguous resolution is never auto-picked on either side.
5. Every WhisperOrg touchpoint in WhisperCal MUST behave identically-or-better with the plugin absent, disabled, not-ready, or version-mismatched — verified per milestone by running the flow with WhisperOrg toggled off.
6. WhisperOrg's Part A additions stay producer-agnostic: no WhisperCal imports, ids, or field names.
7. WhisperCal MUST comply with the eight consumer rules in WhisperOrg `DESIGN.md` §16.9 (mirrored in the generated `PLUGIN_API.md`); in particular: never cache the api object (rule 1), and never subscribe to WhisperOrg events outside `this.registerEvent` (rule 4).

---

## 7. Milestones

Per the WhisperOrg runbook style: one milestone per session, fresh session each, `npm run build` green + manual gate in a **test vault** before commit. Suggested effort: default medium; bump to high where flagged.

**M0 — WhisperCal migration-compatibility (no WhisperOrg dependency; SHIP FIRST).**
`PeopleMatchService` reads become canonical-first with legacy fallback: emails add `work_email`; `personnel_type` reads `employment_type` first; `organization` reads `company` → `organization` → `company/org`; `nickname` reads `aliases` (first entry) → `nickname`. Same for the modal people list if it surfaces nicknames. *Accept:* matching + card icons + roster identical on a legacy note AND on a hand-migrated copy of the same note. *Deploy to the SDA vault before WhisperOrg's all-people migration runs.* Effort: medium.

**M1 — WhisperOrg public API v1 (= WhisperOrg `DESIGN.md` §16, implemented as its milestone M6).**
Run in the WhisperOrg repo, fresh session, with DESIGN.md §1–2 + §16 in context — not this plan. *Accept:* the nine-point checklist in DESIGN.md §16.12 (covers readiness ordering, event re-fire on re-enable, drift guards, error prefixes, `PLUGIN_API.md` generation, and TODO-ORG-1/2). Effort: **Opus high for the whole milestone**, mandatory review pass, per §16.12.

**M2 — WhisperCal bridge + gateway (§5.1–5.2).**
All six call sites through `PeopleGateway`. *Accept:* with WhisperOrg disabled — zero behavior change (spot-check note creation, tagging, enrollment, organizer row); with WhisperOrg enabled — an alias-only person and a handle-only person now match; ambiguous person falls through; voiceprint library names still equal note basenames. Effort: **high** (the voiceprint seam runs through here); mandatory review pass against §6 rules 3–5.

**M3 — Creation delegation (§5.3).**
*Accept:* all three creation paths produce canonical-schema notes when WhisperOrg is enabled (seeded email/company verified), current-format notes when disabled; enrollment chain works end-to-end with a brand-new speaker in both modes. Effort: medium.

**M4 — Deterministic enrichment emission (§5.4 facts pass + §5.5 setting).**
*Accept:* a meeting with (a) a matched person missing their email and (b) an unknown attendee yields exactly two proposals in WhisperOrg's review modal; accepting them updates/creates notes; re-running the same meeting emits nothing (dedup memory); with WhisperOrg absent and no inbox folder, silence. Effort: medium.

**M5 — LLM enrichment pass (§5.4 LLM pass).**
*Accept:* on a real transcript, proposals carry sane types/confidence/evidence; malformed LLM output rejects the batch without side effects; concurrency cap respected; `"facts+llm"` off ⇒ no LLM job. Effort: **high** for the parser/validator, medium elsewhere. Review pass on the emitter.

**M6 — Polish (WhisperOrg integration).**
Settings status line + folder-mismatch warning; roster Context org placement; optional `whisperorg:graph-changed` listener (via `registerEvent`, §5.1 cast) to drop `CalendarView`'s memoized gateway; speaker-modal autocomplete via `listPeople()` (decision D2 — surfaces aliases/handles in the picker, re-queried on graph-changed, folder-scan fallback when WhisperOrg absent); docs (§5.6); version bumps (WhisperCal patch per release convention). Exit note: record the D3 decision on flipping `orgEnrichment`'s default to `"facts"` after M4/M5 have soaked.

**M7 — `meeting_uid` identity spine (REQUIREMENTS ONLY — design deferred to its own session).**
Give every meeting bundle one stable, time-independent, path-independent identifier, minted at capture and carried across Tome → WhisperCal → WhisperOrg. Requirements in §11; open design questions in §11.6. **Not blocked on WhisperOrg** and not blocked on M0–M6 — it is a WhisperCal/Tome data-model change that WhisperOrg later consumes. Sequence it before any WhisperOrg work that wants per-meeting provenance. Effort: **high** (touches Tome, the capture path, and every identity heuristic); mandatory review pass.

Rollout note: M0 → vault ASAP. M1 can land anytime. M2/M3 deploy together to the vault only after WhisperOrg's pilot migration has soaked. M4–M6 at leisure. M7 is independent of all of the above.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `app.plugins` is unofficial API | Single access point (`OrgBridge`), ambient types, full runtime guards, fallback path always alive |
| API drift between repos | Runtime `apiVersion` check + vendored-types header comment naming the source file; bump version on any breaking change |
| WhisperOrg graph races (note created, cache not yet updated) | `createPerson` returns the authoritative ref; callers forbidden from re-resolving (§4.1) |
| API write throws mid-pipeline | §4.2 blanket rule: one warning + legacy/fallback path; pipeline never crashes |
| Two plugins disagree on `peopleFolder` | Settings-tab mismatch warning (§5.5) |
| Proposal spam from recurring meetings | WhisperCal-side dedup memory + WhisperOrg's merge/tombstone dedupe as backstop |
| Vault migration lands before M0 | Sequencing rule in §7 — M0 ships first; this plan is the reminder |
| LLM emits garbage claims | Client pre-validation, batch rejection, review-only apply path, confidence attached |

## 9. Decisions (open questions resolved 2026-07-11)

Recorded so implementing sessions don't re-litigate them; each notes how to revisit.

- **D1 — Organizer sweep keeps synchronous creation** (routed through `createPerson`, M3); it is NOT converted to `new_person` proposals. Rationale: the sweep is already user-opted (setting + template requirement), organizer wiki-links must exist at note-creation time (review latency would break them), and API-created notes now come out canonical-schema — which removes most of the "silent writer" concern that motivated the proposal idea. M4's `new_person` proposals still cover unmatched *attendees*, whose notes nothing waits on. Revisit only if reviewed-before-created becomes a WhisperOrg-side requirement.
- **D2 — Speaker-modal autocomplete via `listPeople()`: yes**, folded into M6 (see M6 scope). Kept out of M2 to keep the gateway milestone purely behavior-preserving.
- **D3 — `orgEnrichment` ships defaulting to `"off"`.** The flip to `"facts"` is a deliberate post-soak decision (one line), recorded at M6 exit — not an implementation blocker.
- **D4 — M5 relationship kinds: conservative subset** — `works_with`, `positive_about`, `negative_about`, `mentor_of` (encoded in §5.4). Widening later touches only the prompt and the shared validator constant.
- **D5 — The fallback minimal stub stays untouched.** It writes only `type: person` + `full_name`, both of which are already canonical in WhisperOrg's schema — there is nothing to rename, and every richer creation goes through the API path anyway.

## 10. References

- WhisperOrg spec: `../WhisperOrg/DESIGN.md` (**§16 Public API v1 — the authoritative Part A spec**; also §2 data model, §3.4 resolver, §7 enrichment contract, §8.2 settings) and `../WhisperOrg/IMPLEMENTATION_GUIDE.md` (session/runbook conventions this plan mirrors)
- Dataview external-API pattern (template for Part A, researched 2026-07-11): [Developing Against Dataview](https://blacksmithgu.github.io/obsidian-dataview/resources/develop-against-dataview/), [`plugin-api.ts`](https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/api/plugin-api.ts); [issue #2209](https://github.com/blacksmithgu/obsidian-dataview/issues/2209) (broken npm typings — the basis for §1.4's vendored-types decision); provenance table in DESIGN.md §16.1
- WhisperCal architecture: `CLAUDE.md`; people surface detail per the 2026-07-10 code survey (§2.1 line references)
- Obsidian inter-plugin patterns: [plugin-to-plugin communication (forum)](https://forum.obsidian.md/t/how-to-create-plugin-apis-for-other-plugins-to-use-plugin-to-plugin-communication/92296), [Plugin API reference](https://docs.obsidian.md/Reference/TypeScript+API/Plugin) — `app.plugins` registry is community-standard but unofficial; hence §1.5/§5.1 guards

---

## 11. M7 — `meeting_uid` identity spine (requirements)

**Added 2026-07-15. Status: REQUIREMENTS ONLY — do not implement from this section.** It states *what must be true*, not how. The design (schema, minting mechanism, migration, Tome API shape) is deliberately deferred to a dedicated session. §11.6 lists the questions that session must answer.

### 11.1 Problem statement

A meeting bundle — note, transcript, audio (`.m4a`), Tome voiceprint sidecar (`.voiceprints.json`) — has **no identifier of its own**. Identity today is three mutually incompatible schemes, none of which spans the bundle:

| Meeting kind | "Identity" today | What's wrong with it |
|---|---|---|
| Calendar-backed | `calendar_event_id` (real Graph/Google id) | Identifies the **calendar event**, not the bundle. Absent for ad hoc. Survives a reschedule (good) but says nothing about the recording. |
| Ad hoc / unscheduled | the literal string `"unscheduled"` | A **sentinel, not an id** — every ad hoc note shares it. Identifies nothing. |
| Tome recording | the transcript's **file path** (`UnlinkedRecording.id`, per its own docstring) | Path-as-identity: any rename or move is a re-identification event. |

Because none of these identifies a bundle, `NoteCreator.findNote()` reconstructs the note↔event link at read time from **heuristics**: canonical-filename guess → `calendar_event_id` + date + time → `meeting_subject` + date + time → basename-contains-subject + date + time. The bundle's internal cohesion (note ↔ transcript ↔ audio ↔ sidecar) is likewise held together by a **filename convention that embeds the meeting time** (`<date> <HHmm> - <subject>[ - Transcript][.m4a|.voiceprints.json]`).

Both couplings are time-derived, and meeting times are not stable.

### 11.2 Evidence (why this is a requirement, not a nice-to-have)

Two real defects, both traced 2026-07-15, both rooted in identity-by-time/path:

1. **The orphan.** A meeting was rescheduled in Outlook 15:30 → 14:30. The Graph id was unchanged and matched perfectly, but `findNote` ANDed that authoritative id with a `meeting_start` equality check, so it returned null. `CalendarView.findLocalNotes` then declined to give the note its own card because its event id *was* in the calendar set. The note and transcript became reachable from no card at all. (Fixed 2026-07-15 in `NoteCreator.findNote` — an id-authoritative fallback when exactly one note claims the id — but the fix is another heuristic layered on the pile.)
2. **The sentinel near-miss.** While fixing (1), an `isRealEventId()` guard proved necessary: matching on `calendar_event_id` would otherwise bind the **shared** `"unscheduled"` placeholder card to whichever ad hoc note happened to be the day's only one. A sentinel masquerading as an id is a live hazard, not a hypothetical.

Related latent defect found in the same investigation (already fixed, but it shows the cost of the current scheme): `meeting_date` is written quoted by `NoteCreator` (`meeting_date: "2026-07-15"`) but any later `processFrontMatter` re-emission strips the quotes, after which Obsidian's YAML re-reads it as a **`Date` object**. Every `fm["meeting_date"] === date` comparison was therefore permanently false, silently disabling both frontmatter fallback scans. `MeetingImporter`'s docstring predicts exactly this failure.

**The through-line:** every one of these is a symptom of re-deriving identity from volatile attributes instead of storing it.

### 11.3 Functional requirements

- **R1.** Every meeting bundle MUST carry exactly one `meeting_uid`: opaque, stable for the life of the bundle, and independent of time, filename, path, subject, and calendar event.
- **R2.** The uid MUST be minted **at capture** — the earliest moment the bundle exists. Tome is the only component present at that moment, so Tome mints it. A recording that never becomes a calendar meeting still has one.
- **R3.** The uid MUST propagate to every artifact of the bundle: transcript frontmatter, meeting-note frontmatter, and the voiceprint sidecar. Audio-file metadata is desirable but MAY be deferred (see §11.6 Q4).
- **R4.** `meeting_uid` MUST be **orthogonal to `calendar_event_id`**, never a replacement. They answer different questions:
  - `meeting_uid` — *"which bundle is this?"*
  - `calendar_event_id` — *"which calendar event does this bundle claim?"*
  Conflating them breaks the moment a recording is relinked to a different meeting: the bundle is unchanged, the event changes. Relinking MUST rewrite `calendar_event_id` and MUST NOT rewrite `meeting_uid`.
- **R5.** When present, `meeting_uid` MUST take precedence over every existing heuristic in `findNote` and in the unlinked-recording matching path.
- **R6.** WhisperOrg MUST be able to key per-meeting provenance on `meeting_uid` — including for ad hoc meetings, which have no calendar id at all and are today unaddressable. This is the integration payoff and the main reason the milestone lives in this plan.
- **R7.** The uid MUST NOT appear in any filename. Filenames stay human-readable and time-prefixed; the uid is for machines. (Explicitly rejected: GUID-named files.)

### 11.4 Compatibility requirements

- **R8.** Legacy bundles have no uid and MUST keep working unchanged: absent uid ⇒ fall back to today's heuristics, verbatim. No forced migration, no backfill pass as a precondition.
- **R9.** Tome is a third-party app (locally patched). If a Tome-side mint is unavailable, WhisperCal MUST be able to mint on first sight of a transcript and write it back — strictly a fallback, and it loses the pre-transcript window (R2's real value). This constraint drives Q1.
- **R10.** The uid MUST survive every existing rename path (`MeetingRenamer`), the merge path (`MeetingMerger`), the import/export bundle path (`MeetingImporter`/`MeetingExporter` — note its deliberate line-surgery frontmatter editing, §11.2), and re-recording (`ReRecordConfirmModal`). Merge and re-record are the hard cases: see Q3.
- **R11.** The uid MUST NOT be re-emitted in a form that changes type on read. Store it as a quoted string; it MUST NOT be YAML-coercible to a Date, number, or bool. (This is the §11.2 `meeting_date` lesson stated as a rule — a bare hex or digit-leading uid is a real hazard.)

### 11.5 Non-goals

- Not a fix for the reschedule orphan — that is fixed, and `meeting_uid` would **not** have prevented it. A stable id (`calendar_event_id`) was already present and already matched; the bug was that the code second-guessed it with a time qualifier. A new id would have been discarded by the same AND. **Adding identity does not help when existing identity is being overruled** — do not justify this milestone on that defect.
- Not a replacement for `calendar_event_id` (R4).
- Not a people/person identifier — that is WhisperOrg's `Person` schema and is out of scope.
- Not a filename scheme (R7).

### 11.6 Open questions for the design session

- **Q1 — Where does the mint live?** Tome-side (satisfies R2 fully; requires a Tome patch and a Tome API surface — today `RecordingStatus` exposes only `state` / `subject` / `startedAt`, i.e. **no id whatsoever**, and `UnlinkedRecording.id` is a file path) vs WhisperCal-side on first sight (no Tome change; violates R2's spirit; loses the capture→transcript window). Recommendation to evaluate: Tome-side, with WhisperCal-side as the R9 fallback.
- **Q2 — Uid format.** UUIDv4 vs UUIDv7 vs Tome's own recording id if one can be exposed. UUIDv7's embedded timestamp is *sortable* but reintroduces a time coupling — decide deliberately whether that is a feature or a trap given this milestone's whole premise. Must satisfy R11.
- **Q3 — Merge and re-record semantics.** When two bundles merge (`MeetingMerger`), does the survivor keep one uid, keep a list, or mint a new one with provenance to both? When a meeting is re-recorded, is it the same bundle (same uid, new audio) or a new one? These are product decisions, not implementation details, and R10 cannot be satisfied without answering them.
- **Q4 — Audio metadata.** Is embedding the uid in `.m4a` tags worth it (survives export out of the vault entirely) or is frontmatter + sidecar sufficient? Note both audio and sidecar already have **convention-based resolution fallbacks** (`<transcript basename>.m4a`, `<transcript path>.voiceprints.json`), so today they survive a lock-step rename without any pointer at all.
- **Q5 — Backfill.** R8 forbids requiring it, but is an opt-in "stamp uids on existing bundles" command worth building for the ~existing vault, or do legacy bundles simply age out?
- **Q6 — Does `"unscheduled"` survive?** Once a uid exists, the sentinel's only remaining job is "no calendar event backs this". That could become an absent/null `calendar_event_id` instead, deleting a whole class of the §11.2(2) hazard. Decide whether M7 also retires the sentinel, and whether that is a breaking change for existing notes.
