# Recurring-meeting prep via the Research pill (per-series notes)

Status: **spec / not started.** Target: a fresh coding agent with no prior conversation context should be able to implement this end to end from this document alone.

> Line numbers below are anchors as of writing and **will drift** — match on the quoted surrounding code / function names, not the numbers.

---

## 1. Problem & approach

The user prepares for daily/weekly **recurring** meetings by gathering talking points from the vault (and, later, Jira). The work is largely mechanical research that differs *per meeting series* (one meeting pulls a Jira board, another reviews action items from the last occurrence, etc.).

The existing **Research pill** already does LLM-driven meeting research, but it's a one-shot manual flow: every click pops `ResearchModal`, where the user re-picks context notes and (only in bypass mode) re-types instructions. For a recurring meeting that's the same ritual every day.

**This feature:** reuse the Research pill unchanged in spirit. For a recurring meeting that has a configured **meeting-series note**, pre-fill the Research modal from that note:
- the bespoke instruction → the modal's instructions box, run as **`additionalInstructions` appended to the existing research scaffold prompt** (NOT bypass / not a replacement prompt);
- the note's default context notes → the modal's pre-selected paths.

The user reviews and submits as normal. **v1 is manual** (modal-driven). The design must leave a clean seam for a future background "automatic" pass (see §9), but that pass is **out of scope here**.

### Why this is mostly wiring

`buildTrigger` (`src/services/LlmInvoker.ts:136`) already composes exactly the runtime shape the user wants. In normal mode the scaffold prompt file is injected into the **system prompt** via `--append-system-prompt` (cacheable prefix), and the per-run variables are appended to the user message — including:

```
if (opts.researchNotePaths && opts.researchNotePaths.length > 0) parts.push(`Research notes: ${opts.researchNotePaths.join(", ")}.`);
if (opts.additionalInstructions) parts.push(`Additional instructions: ${opts.additionalInstructions}`);
```

So "scaffold + bespoke instruction appended at the end" = the existing `additionalInstructions` path, and putting the per-series text there (rather than in the system prompt) is also **cache-correct** because it's the part that varies per series. The default research prompt already has a "Follow additional instructions" step, so **the prompt file needs no changes.**

The only gaps: (a) a durable way to identify a recurring *series* so we can find its note; (b) the note itself + a setting for where they live; (c) the modal currently hides the instructions textarea unless "bypass" is checked, so the (already-wired) `additionalInstructions` UI is unreachable in normal mode.

---

## 2. Load-bearing facts (verified)

- **Research flow** lives in `WhisperCalPlugin.doResearch` (`src/main.ts:1167`). It reads the occurrence note's frontmatter (`:1173`), opens `ResearchModal` **with no seed** (`:1178`), stores selected paths into the occurrence note's `research_notes` frontmatter (`:1190`), then calls `runLlmJob({jobKind:"research", …})`. In **normal mode** it passes `promptPath: researchPromptPath`, `researchNotePaths: result.paths`, and `additionalInstructions: result.instructions` (`:1199`,`:1215`,`:1216`).
- **`ResearchModal`** (`src/ui/ResearchModal.ts`): constructor is `(app, meetingTitle, subtitle, initialPaths?: string[])` (`:28`) — **`initialPaths` already exists and is simply never passed.** The instructions `<textarea>` (`this.instructionsEl`) and a "Use as direct prompt (bypass prompt file)" checkbox exist; `updateBypassState()` (`:122`) **hides the textarea unless bypass is checked**. `onClose` (`:184`) validates: bypass → requires textarea text; normal → requires ≥1 selected note (`:188`). Result shape: `{paths, instructions, bypassPrompt}` (`:4`).
- **`buildTrigger`** appends `Research notes:` and `Additional instructions:` in both modes (`src/services/LlmInvoker.ts:155-156`) — pre-selected context notes are never silently dropped.
- **Calendar event model** `CalendarEvent` (`src/types.ts:14`) has `isRecurring: boolean` but **no series identifier**.
- **Microsoft Graph** returns `seriesMasterId` (stable across all occurrences of a series) but it is **not** in the `$select` (`src/services/GraphApiProvider.ts:115`) nor on the `GraphEvent` interface (`:36`). Recurrence is inferred from `type !== "singleInstance"` (`:212`).
- **Google** already fetches `recurringEventId` (`src/services/GoogleCalendarProvider.ts:62`) but only uses it for `isRecurring: !!event.recurringEventId` (`:197`); it is not surfaced.
- **Note creation** `NoteCreator.injectReservedFrontmatter` (`src/ui/NoteCreator.ts:237`) writes the plugin-owned frontmatter block (`meeting_subject`, `meeting_date`, `meeting_start`, `calendar_event_id`, `is_recurring`, …). `findNote` (`:36`) matches occurrence notes by `calendar_event_id`+date+time, then `meeting_subject`+date+time, then basename+date.
- **Frontmatter keys** are centralized in `FM` (`src/constants.ts:22`). Command IDs are `COMMAND_*` constants in the same file.
- **Helpers available:** `updateFrontmatter(app, path, key, value)` & `readFmString(fm, key)` (`src/utils/frontmatter.ts`); `sanitizeFilename(name)` & `yamlEscape(s)` (`src/utils/sanitize.ts`); `getMarkdownFilesRecursive(folder)` & `ensureFolder(app, path)` & `resolveWikiLink` (`src/utils/vault.ts`); `app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)` for wikilink→TFile.
- **Settings UI** is `WhisperCalSettingTab` in `src/settings.ts`. Folder-path settings use the `addTextSetting({container, name, desc, placeholder, get, set, suggest:"folder", browse:true})` helper (`:222`). The LLM section starts at `:643`; per-prompt subsections are added by `addPromptSetting(...)`, with "Research" at `:884`.

### Why `seriesMasterId`/`recurringEventId` is the right key (evidence)

Comparing every `calendar_event_id` across occurrences of two real recurring series in the user's vault (`~/SDA/6 Meeting Summaries`):

| Series | occurrences | id length | common prefix | common suffix | variable region |
|---|---|---|---|---|---|
| C2Ops Daily Standup Call | 59 | 168 | 61 | 101 | **6 chars** (one contiguous middle) |
| Daily SDA MCL synch | 33 | 168 | 61 | 6 | **~101 chars** (variance at *both* ends of the tail) |

Conclusions: per-occurrence `calendar_event_id` is genuinely distinct each time; you **cannot** reliably derive a series key by masking it (variance layout is series-dependent — 6 chars for one series, two disjoint spans across ~100 chars for another); and the 61-char prefix is identical *across different series* (it encodes the mailbox, not the meeting). Therefore: use the providers' real series id. Existing notes (created before this feature) won't have it → fall back to **subject** matching, which is stable for recurring meetings and already used as a fallback in `findNote`.

---

## 3. Scope

**In scope (v1, manual):**
1. Surface a durable series id on `CalendarEvent` and persist it on occurrence notes.
2. A "meeting-series note" type + a setting for the folder they live in.
3. A resolver that maps an occurrence → its series note → `{instruction, paths}`.
4. Seed `ResearchModal` from the resolver; show the instructions textarea in normal mode.
5. A command to create/open the series note for the active meeting.

**Out of scope (future, design the seam only):**
- The background/automatic prep pass (§9).
- Jira/MCP sourcing (the instruction can *name* Jira; wiring the spawned CLI's `--mcp-config` to reach Jira is a separate effort). v1 sources are vault-only, which already covers "review action items from the last occurrence."
- Writing edited instructions back from the modal to the series note ("save-back").

---

## 4. Data model

### 4.1 Occurrence note — new frontmatter key
`meeting_series_id` — the provider series id (`seriesMasterId` / `recurringEventId`). Written only when non-empty (i.e. recurring events). Used by the resolver to find the series note; also the anchor a future auto pass scans on.

### 4.2 Meeting-series note (new note type)
One note per recurring series, living in the new `seriesNotesFolderPath`. Intended as a general "what the vault knows about this series" home — keep it extensible; this feature only reads two things from it.

Frontmatter:
- `series_id: "<provider series id>"` — primary match key (self-healed in, see §6).
- `series_subject: "<subject>"` — fallback match key + readability.
- `match_subjects: ["alt name", …]` — optional manual aliases (handles renames).
- `research_notes: "[[Path/A]], [[Path/B]]"` — optional default context notes (same wikilink format the Research flow already writes to occurrence notes). Pre-selected in the modal.
- `tags: [meeting-series]`.

Body:
- A section headed exactly `## Research instructions` whose text becomes `additionalInstructions`. Everything else in the body is free for human notes / future features (extract only this one section).

> Series notes MUST live in a folder distinct from `noteFolderPath`, and they lack `calendar_event_id`/`meeting_date`, so `CalendarView` will not render them as meeting cards.

### 4.3 Settings — new key
`seriesNotesFolderPath: string`, default `""` (empty = feature dormant; resolver returns `null` and Research behaves exactly as today).

---

## 5. Changes by file

### 5.1 `src/types.ts` — add series id to the event
```ts
export interface CalendarEvent {
	id: string;
	subject: string;
	// …
	isRecurring: boolean;
	seriesId: string;   // NEW: provider series id; "" for non-recurring / single instances
	responseStatus: ResponseStatus;
	categories: EventCategory[];
}
```

### 5.2 `src/services/GraphApiProvider.ts` — fetch & map `seriesMasterId`
- Add to the `GraphEvent` interface (near `:49`): `seriesMasterId?: string | null;`
- Add `seriesMasterId` to the `$select` list (`:115`).
- In `parseGraphEvent` return object (`:197`), add: `seriesId: event.seriesMasterId ?? "",`

### 5.3 `src/services/GoogleCalendarProvider.ts` — surface `recurringEventId`
- In the `parseGoogleEvent` return object (near `:197`, alongside `isRecurring`), add: `seriesId: event.recurringEventId ?? "",` (the field already exists on `GoogleCalendarEvent`, `:62`).

### 5.4 `src/constants.ts` — new FM key + command id
- Add to `FM`: `MEETING_SERIES_ID: "meeting_series_id",`
- Add a command id: `export const COMMAND_OPEN_SERIES_NOTE = "open-meeting-series-note";`

### 5.5 `src/ui/NoteCreator.ts` — persist `meeting_series_id` on occurrence notes
In `injectReservedFrontmatter` (`:245`), the `reserved` array is `.join("\n")` inline. Restructure to append the series id conditionally so non-recurring notes don't get an empty key:
```ts
const reserved = [
	`meeting_subject: "${yamlEscape(event.subject)}"`,
	// … unchanged lines …
	`is_recurring: ${event.isRecurring}`,
];
if (event.seriesId) {
	reserved.push(`${FM.MEETING_SERIES_ID}: "${yamlEscape(event.seriesId)}"`);
}
const reservedStr = reserved.join("\n");
// … use reservedStr where the old `.join("\n")` result was used …
```

### 5.6 NEW `src/services/SeriesPrep.ts` — resolver + stub creation
The single seam shared by the manual flow (now) and a future auto pass (§9). Self-contained; no UI.

```ts
import {App, TFile, TFolder, normalizePath} from "obsidian";
import type {WhisperCalSettings} from "../settings";
import {FM} from "../constants";
import {readFmString, updateFrontmatter} from "../utils/frontmatter";
import {sanitizeFilename, yamlEscape} from "../utils/sanitize";
import {ensureFolder, getMarkdownFilesRecursive} from "../utils/vault";

/** Frontmatter keys specific to a meeting-series note. */
export const SERIES_FM = {
	SERIES_ID: "series_id",
	SERIES_SUBJECT: "series_subject",
	MATCH_SUBJECTS: "match_subjects",
	RESEARCH_NOTES: "research_notes",
} as const;

export const RESEARCH_INSTRUCTIONS_HEADING = "Research instructions";

export interface SeriesPrep {
	seriesNotePath: string;
	instruction: string;   // body under "## Research instructions", trimmed; "" if absent
	paths: string[];       // resolved vault paths from research_notes; [] if absent
}

/** Locate the series note for a meeting: by series_id, then by subject. */
export function findSeriesNote(
	app: App, settings: WhisperCalSettings, seriesId: string, subject: string,
): TFile | null {
	if (!settings.seriesNotesFolderPath) return null;
	const folder = app.vault.getAbstractFileByPath(settings.seriesNotesFolderPath);
	if (!(folder instanceof TFolder)) return null;
	const files = getMarkdownFilesRecursive(folder);

	// 1. Durable: by series_id
	if (seriesId) {
		for (const f of files) {
			const fm = app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm && fm[SERIES_FM.SERIES_ID] === seriesId) return f;
		}
	}
	if (!subject) return null;

	// 2. Canonical filename = sanitized subject
	const canonical = normalizePath(`${settings.seriesNotesFolderPath}/${sanitizeFilename(subject)}.md`);
	const direct = app.vault.getAbstractFileByPath(canonical);
	if (direct instanceof TFile) return direct;

	// 3. by series_subject / match_subjects
	for (const f of files) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) continue;
		if (fm[SERIES_FM.SERIES_SUBJECT] === subject) return f;
		const alts = fm[SERIES_FM.MATCH_SUBJECTS];
		if (Array.isArray(alts) && alts.includes(subject)) return f;
	}
	return null;
}

/** Resolve prep for an occurrence note's frontmatter. null = no series note (feature dormant). */
export async function resolveSeriesPrep(
	app: App, settings: WhisperCalSettings, occurrenceFm: Record<string, unknown> | undefined,
): Promise<SeriesPrep | null> {
	if (!settings.seriesNotesFolderPath || !occurrenceFm) return null;
	const seriesId = readFmString(occurrenceFm, FM.MEETING_SERIES_ID) ?? "";
	const subject = readFmString(occurrenceFm, "meeting_subject") ?? "";
	const note = findSeriesNote(app, settings, seriesId, subject);
	if (!note) return null;

	const noteFm = app.metadataCache.getFileCache(note)?.frontmatter ?? {};
	// Self-heal: stamp series_id when matched by subject and missing.
	if (seriesId && !readFmString(noteFm, SERIES_FM.SERIES_ID)) {
		await updateFrontmatter(app, note.path, SERIES_FM.SERIES_ID, seriesId);
	}

	const content = await app.vault.cachedRead(note);
	const instruction = extractMarkdownSection(content, RESEARCH_INSTRUCTIONS_HEADING);
	const paths = parseWikilinkPaths(app, readFmString(noteFm, SERIES_FM.RESEARCH_NOTES), note.path);
	return {seriesNotePath: note.path, instruction, paths};
}

/** Create (or find+open) the series note for a meeting; returns its path. */
export async function ensureSeriesNote(
	app: App, settings: WhisperCalSettings, seriesId: string, subject: string,
): Promise<string> {
	const existing = findSeriesNote(app, settings, seriesId, subject);
	if (existing) {
		const fm = app.metadataCache.getFileCache(existing)?.frontmatter ?? {};
		if (seriesId && !readFmString(fm, SERIES_FM.SERIES_ID)) {
			await updateFrontmatter(app, existing.path, SERIES_FM.SERIES_ID, seriesId);
		}
		return existing.path;
	}
	await ensureFolder(app, settings.seriesNotesFolderPath);
	const path = normalizePath(`${settings.seriesNotesFolderPath}/${sanitizeFilename(subject)}.md`);
	const body = [
		"---",
		`series_id: "${yamlEscape(seriesId)}"`,
		`series_subject: "${yamlEscape(subject)}"`,
		`tags: [meeting-series]`,
		`research_notes: ""`,
		"---",
		"",
		`## ${RESEARCH_INSTRUCTIONS_HEADING}`,
		"",
		"<!-- Bespoke prep instructions for this recurring meeting; appended to the research prompt at runtime.",
		"     e.g. 'List open items from the SDA Jira board and the action items from the previous occurrence.' -->",
		"",
	].join("\n");
	const file = await app.vault.create(path, body);
	return file.path;
}

/** Body under the first heading whose text == `heading` (case-insensitive, any level),
 *  up to the next heading of the same or higher level. */
function extractMarkdownSection(content: string, heading: string): string {
	const lines = content.split("\n");
	const target = heading.trim().toLowerCase();
	let start = -1, level = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[i] as string);
		if (m && (m[2] as string).trim().toLowerCase() === target) { start = i + 1; level = (m[1] as string).length; break; }
	}
	if (start === -1) return "";
	const out: string[] = [];
	for (let i = start; i < lines.length; i++) {
		const m = /^(#{1,6})\s+/.exec(lines[i] as string);
		if (m && (m[1] as string).length <= level) break;
		out.push(lines[i] as string);
	}
	return out.join("\n").trim();
}

/** Parse a comma-joined "[[link]], [[link|alias]]" string into resolved vault paths. */
function parseWikilinkPaths(app: App, value: string | undefined, sourcePath: string): string[] {
	if (!value) return [];
	const paths: string[] = [];
	for (const m of value.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
		const dest = app.metadataCache.getFirstLinkpathDest((m[1] as string).trim(), sourcePath);
		if (dest) paths.push(dest.path);
	}
	return paths;
}
```

> If the comment block in `ensureSeriesNote`'s template trips the section extractor or feels noisy, drop it — only the `## Research instructions` heading is required. The extractor returns "" for an empty section, which is fine (the modal just opens with an empty instructions box).

### 5.7 `src/ui/ResearchModal.ts` — seedable instructions + visible in normal mode
- **Constructor:** add two optional params after `initialPaths`:
  ```ts
  constructor(app: App, meetingTitle: string, subtitle: string,
              initialPaths?: string[], initialInstructions?: string, initialBypass?: boolean) {
  ```
  Store `this.initialInstructions = initialInstructions ?? ""` and `this.initialBypass = initialBypass ?? false`.
- **`onOpen`:** after creating `bypassCheckbox` and `instructionsEl`, seed them: `this.bypassCheckbox.checked = this.initialBypass;` and `this.instructionsEl.value = this.initialInstructions;` (before the existing `this.updateBypassState()` call at `:88`).
- **`updateBypassState` (`:122`):** stop hiding the textarea; instead relabel it. The textarea is now always visible:
  ```ts
  private updateBypassState(): void {
  	const bypass = this.bypassCheckbox.checked;
  	this.instructionsLabel.setText(bypass
  		? "Direct prompt (replaces the prompt file)"
  		: "Additional instructions (appended to the research prompt)");
  	if (bypass) this.instructionsEl.focus();
  }
  ```
  Remove the two `toggleClass("whisper-cal-hidden", !bypass)` lines. (The `whisper-cal-hidden` CSS class can stay unused.)
- **`onClose` validation (`:188`):** allow an instruction-only run in normal mode:
  ```ts
  const hasValidInput = bypass
  	? text.length > 0
  	: (this.selected.size > 0 || text.length > 0);
  ```

> Net UX effect for *all* meetings: the Research modal now always shows an "Additional instructions" box (previously reachable only via bypass). This is intended and makes the append path usable generally.

### 5.8 `src/main.ts` — seed the modal + new command
**In `doResearch` (`:1167`)**, resolve series prep before opening the modal and pass the seed:
```ts
const fm = this.app.metadataCache.getFileCache(noteFile)?.frontmatter ?? {};
const title = (fm["meeting_subject"] as string) || noteFile.basename;
const subtitle = buildMeetingSubtitle(fm);

void (async () => {
	const seriesPrep = await resolveSeriesPrep(this.app, this.settings, fm);
	const result = await new ResearchModal(
		this.app, title, subtitle, seriesPrep?.paths, seriesPrep?.instruction,
	).prompt();
	if (!result) return;

	// Allow instruction-only runs (no context notes selected) in normal mode.
	if (!result.bypassPrompt && result.paths.length === 0 && !result.instructions) return;
	if (!result.bypassPrompt && !this.settings.researchPromptPath) { /* unchanged notice */ return; }
	// … rest of doResearch unchanged (research_notes write, runLlmJob) …
})();
```
Import `resolveSeriesPrep` from `./services/SeriesPrep`.

**Register the new command** (near the other `addCommand` calls, e.g. by `COMMAND_RESEARCH` at `:299`):
```ts
this.addCommand({
	id: COMMAND_OPEN_SERIES_NOTE,
	name: "Open meeting series note",
	checkCallback: (checking) => {
		const file = this.app.workspace.getActiveFile();
		if (!file) return false;
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm?.[FM.MEETING_SUBJECT_KEY_OR_LITERAL]) return false; // requires a meeting note (has meeting_subject)
		if (!this.settings.seriesNotesFolderPath) return false;      // feature must be configured
		if (checking) return true;
		void (async () => {
			const seriesId = (fm[FM.MEETING_SERIES_ID] as string) ?? "";
			const subject = (fm["meeting_subject"] as string) ?? "";
			const path = await ensureSeriesNote(this.app, this.settings, seriesId, subject);
			await this.app.workspace.openLinkText(path, "", false);
		})();
		return true;
	},
});
```
(`meeting_subject` has no `FM` constant today — use the string literal `"meeting_subject"` as the rest of the codebase does, or add `MEETING_SUBJECT: "meeting_subject"` to `FM` and use it consistently.) Import `ensureSeriesNote` from `./services/SeriesPrep` and `COMMAND_OPEN_SERIES_NOTE` from `./constants`.

> Optional polish (not required): add a small "series note" affordance to `MeetingCard` for recurring meetings that routes to this command. Keep v1 to the command if simpler.

### 5.9 `src/settings.ts` — interface, default, UI
- **Interface** (`WhisperCalSettings`, near the other path settings): `seriesNotesFolderPath: string;`
- **`DEFAULT_SETTINGS`:** `seriesNotesFolderPath: "",`
- **UI:** add a folder setting in the **LLM** section, immediately after the `addPromptSetting("Research", …)` call (`:884-891`):
  ```ts
  this.addTextSetting({
  	container: containerEl,
  	name: "Meeting series notes folder",
  	desc: "Vault folder of per-series notes for recurring meetings. Each note holds bespoke research instructions (under a '## Research instructions' heading) that pre-fill the Research modal for that series. Leave empty to disable.",
  	placeholder: "Meeting Series",
  	get: () => this.plugin.settings.seriesNotesFolderPath,
  	set: v => { this.plugin.settings.seriesNotesFolderPath = v; },
  	suggest: "folder",
  	browse: true,
  });
  ```
  (This block is inside the existing sentence-case eslint-disable region around the LLM section; keep it there.)

### 5.10 No prompt-file change
The default research prompt already consumes `Additional instructions:`. Do **not** modify `prompts/Meeting Research Prompt.md` or `PromptInstaller`. (Optional, content-only: the user may later enrich the prompt to emphasize "prior-occurrence action items" for recurring meetings — that's tuning, not code.)

### 5.11 Optional: `src/services/TemplateEngine.ts`
If template authors want `{{seriesId}}`, add it to the variable map in `buildVariableMap`. Not required for this feature.

---

## 6. Resolution algorithm (summary)

Given an occurrence note's frontmatter:
1. If `seriesNotesFolderPath` is empty → return `null` (Research unchanged).
2. Read `meeting_series_id` (→ `seriesId`) and `meeting_subject` (→ `subject`).
3. Find the series note: by `series_id` match; else canonical `<folder>/<sanitized subject>.md`; else `series_subject` / `match_subjects`.
4. If found and matched by subject while it lacks `series_id` but we have one → **stamp it** (`updateFrontmatter`). Self-healing; survives subject renames thereafter.
5. Extract the `## Research instructions` body → `instruction`; parse `research_notes` wikilinks → `paths`.
6. Seed the modal: `initialInstructions = instruction`, `initialPaths = paths`, bypass off.

---

## 7. Edge cases

- **No series note / feature off:** resolver returns `null`; modal opens blank exactly as today.
- **Existing 691 notes (no `meeting_series_id`):** matched by subject; `series_id` gets stamped onto the series note the first time an occurrence that *does* carry one is researched.
- **Series recreated (new `seriesMasterId`):** subject fallback still finds the note; the stamped `series_id` updates on next resolve. `match_subjects` covers manual renames.
- **Empty `## Research instructions`:** `instruction = ""`; modal opens with an empty box (still valid to submit if notes are selected, or the user types something).
- **Series note in the meetings folder by mistake:** keep `seriesNotesFolderPath` distinct from `noteFolderPath`; series notes lack `calendar_event_id`/`meeting_date` so `CalendarView` ignores them regardless.
- **`research_notes` wikilink that doesn't resolve:** `getFirstLinkpathDest` returns null → silently skipped (no broken path passed to the LLM).
- **Non-recurring meeting:** `seriesId` is `""`; `meeting_series_id` not written; resolver may still match a series note by subject if the user made one (acceptable — lets the user attach prep to any repeating-by-name meeting).

---

## 8. Verification

1. `npm run build` && `npm run lint` (strict null checks, `noUncheckedIndexedAccess` — note the `as string` casts in the helpers).
2. Deploy `main.js`, `manifest.json`, `styles.css` to `~/SDA/.obsidian/plugins/whisper-cal/`; reload Obsidian.
3. Scenarios:
   - **Feature off** (`seriesNotesFolderPath` empty): Research pill on any meeting → blank modal, unchanged behavior. Regression baseline.
   - **New occurrence note** for a recurring meeting now has `meeting_series_id` in frontmatter (MS Graph and/or Google).
   - Set `seriesNotesFolderPath`; run command **"Open meeting series note"** from a recurring meeting note → creates `<folder>/<subject>.md` stub with `series_id`, `series_subject`, `## Research instructions`. Write an instruction + a `research_notes:` wikilink.
   - Click **Research** on that meeting (or a future occurrence) → modal opens with the instruction pre-filled in a visible "Additional instructions" box and the context note pre-selected → submit → research runs and writes `## Research` into the occurrence note. Confirm (debug logging on, `src/utils/debug.ts` / `llmDebugLogging`) the trigger contains `Additional instructions: …` and `Research notes: …`.
   - Rename the series in Outlook/Google (new occurrences get a new subject but same `seriesMasterId`): resolver still finds the note by `series_id`; verify it does **not** create a duplicate.
   - Hand-create a series note by subject only (no `series_id`) → research a recurring occurrence that has a `meeting_series_id` → confirm the note gets `series_id` stamped (self-heal).

---

## 9. Future automatic mode (seam only — DO NOT BUILD HERE)

The design principle that keeps "auto later" cheap: **`ResearchModal` is the only manual-only step.** Everything from a resolved `SeriesPrep` onward (`runLlmJob({jobKind:"research", promptPath, additionalInstructions, researchNotePaths})`) is reusable as-is.

A future background pass would mirror `src/services/AutoSpeakerTagger.ts`: a listener + startup catch-up over upcoming recurring meetings, **gated by the existing "Automatic mode" switch** (`autoSummarizeAfterTagging`), that for each occurrence with a series note and no existing `## Research` section calls `resolveSeriesPrep` and runs the same research job headlessly (no modal). Idempotency = presence of the `## Research` section (or a stamp). Concurrency via the existing `llmMaxConcurrent` slot logic. Build the resolver in `SeriesPrep.ts` (done in v1) so that pass is a thin new caller, not a rewrite.

Jira/MCP sourcing would arrive with that pass (or independently): the per-series instruction names the source; the spawned `claude` reaches Jira only via `--mcp-config` in `researchFlags`, and that subprocess authenticates independently of the Obsidian session — validate headless before relying on it.
