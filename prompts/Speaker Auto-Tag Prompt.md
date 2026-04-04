# Speaker Auto-Tag Prompt

Self-contained prompt for tagging unidentified speakers in a single transcript stub. Runs the full 6-rule speaker identification algorithm using vault data (People notes, calendar attendees) — no MacWhisper DB interaction.

**Design principle:** This prompt is a self-contained, single-transcript analysis unit. It analyzes one transcript and returns proposed speaker mappings. The calling plugin handles user review and writing changes.

**Invocation pattern:**
```
Follow the instructions in <path to this prompt file>.
Transcript: Transcripts/2026-03-02 - Weekly Standup - Transcript.md.
Microphone user: Jane Smith.
Output format: <caller specifies expected output format>
```

**Optional parameters:**
- `Calendar Attendees:` — pre-fetched attendee table (skips Step 5)
- `People Roster:` — pre-built context table (skips Step 6 People resolution entirely)
- `People Folder:` — folder name for People notes (default: `People`)

---

## Step 0: Pre-load Tools

If Read, Glob, and Grep are already available (e.g., loaded earlier in the conversation), **skip this step**.

Otherwise, load all required tools in a single call:

```
ToolSearch("select:Read,Glob,Grep")
```

---

## Step 1: Parse Invocation Parameters

Extract from the calling message:
- `Transcript:` → path to the transcript stub file
- `Microphone user:` → full name of the person speaking into the microphone
- `Calendar Attendees:` → pre-fetched attendee context table (optional — skips Step 5 if provided)
- `People Roster:` → pre-built People context table (optional — skips Step 6 People resolution entirely)
- `People Folder:` → folder name for People notes (optional — defaults to `People`)
- `Output format:` → the expected output format for the proposed mapping (provided by the caller)

**Path resolution:** Try the `Transcript:` path as-is first. If not found, error with: "Transcript file not found: [path]. Check the path and try again."

**Vault root derivation:** Extract the vault root from the transcript path by removing the transcript folder suffix. Use this derived root combined with `{People Folder}/` for all subsequent lookups.

**Derived values (from filename — no file read needed):**
- `MEETING_TITLE` — strip date prefix (first 13 chars for `YYYY-MM-DD - ` or first 11 chars for `YYYY-MM-DD `) and ` - Transcript` suffix from the filename
- `SANITIZED_SUBJECT` — take `MEETING_TITLE`, replace filesystem-unsafe characters (`/`, `\`, `:`) with hyphens. Used for cache Glob in Step 2.

---

## Step 2: Read Transcript Stub + Glob Roster Cache

**Parallelization opportunity:** The `SANITIZED_SUBJECT` was derived from the filename in Step 1 (no file read needed). Issue the transcript Read and the roster cache Glob in the **same parallel tool-call batch**:

```
Read(transcript_path)                                                    // Step 2
Glob("Caches/Speaker Rosters/{SANITIZED_SUBJECT}.md")                   // Step 6 cache early
```

Use the **Read tool** to open the transcript file. Extract from frontmatter:

| Field | Notes |
|-------|-------|
| `session_id` | Standard pipeline stubs |
| `macwhisper_session_id` | WhisperCal stubs — use when `session_id` is absent |
| `speakers` | Array with name, id, stub flag, line_count per speaker |
| `calendar_event` | String (event title), `"none"`, or absent |
| `calendar_attendees` | Array of plain string names — if present |
| `invitees` | WhisperCal variant of `calendar_attendees` |
| `meeting_invitees` | Wiki-link attendee list (e.g. `- "[[Name]]"`) — check this field too |
| `meeting_subject` | Meeting title — used to validate cache match |
| `is_recurring` | Boolean — enables roster cache path |
| `pipeline_state` | Current state in pipeline |
| `tags` | Detect WhisperCal stubs (`tags: [transcript]`) |

**Also extract:** The full transcript body (everything below the frontmatter closing `---`). This is the primary input for speaker analysis in Step 7.

**Error conditions:**
- File has no frontmatter (no `---` delimiters) → error: "File has no YAML frontmatter. Is this a transcript stub?"
- No `session_id` or `macwhisper_session_id` field → warning: "No session ID found. Proceeding — session ID is metadata only."

---

## Step 3: Pipeline State Check

Read `pipeline_state` from stub frontmatter:

- `pipeline_state: tagged` or `extracted` or `summarized` → proceed (re-running with updated confidence)
- `pipeline_state: titled` or absent → proceed

---

## Step 5: Calendar Attendees

**Skip this step entirely if** `Calendar Attendees:` was provided in the invocation parameters (pre-fetched by orchestrator). Use the provided table directly.

**Also skip if** `People Roster:` was provided — calendar attendees are already incorporated into the roster.

Determine the calendar attendee source:

- **`calendar_event: none`** → skip calendar lookups (ad-hoc meeting), proceed to Step 6
- **`calendar_attendees`, `invitees`, or `meeting_invitees` populated** → use directly (strip `[[` / `]]` wiki-link wrappers if present)
- **No calendar data from any source** → proceed without; calendar context improves confidence but is not required

---

## Step 6: Speaker Candidate Roster

**Skip this entire step if** `People Roster:` was provided in the invocation parameters. Use the provided roster as the People context table directly and proceed to Step 7.

Build the speaker candidate roster from vault-native sources. This is the primary enrichment step — all data comes from the vault.

### 6a. People Context Table

Collect all unique names from: stub speakers (frontmatter) and calendar attendees (Step 5).

**Completeness check:** After collection, verify every calendar invitee produced at least one candidate name. If any invitee was not resolved to a name (e.g., unparseable email format), log a warning: `"Could not extract name from invitee: {raw_value}"` and skip that entry rather than silently dropping it.

#### Roster Cache Check

**Priority order:** `People Roster:` parameter (highest — skips Step 6 entirely) > cache hit (skips Phase 1+2 Globs/Reads below) > full rebuild.

The cache Glob was already issued in Step 2 (parallel with the transcript Read). Use those results here.

1. **Eligibility:** Transcript has `meeting_subject` AND `is_recurring: true`.
2. **Lookup:** Use the cache Glob result from Step 2.
3. **If found, Read it.** Check the `generated` frontmatter field:
   - **Fresh (< 14 days old):** Compare current candidate names (from stubs + calendar collected above) against the cached roster's `Full Name` column.
     - **All present** → use the cached table as the People context table. **Skip Phase 1 + Phase 2 entirely.** Proceed to Step 7.
     - **New names found** → run Phase 1 + Phase 2 below for **only the new names** (delta resolution). Merge results into the cached table. Use the merged table as the People context table.
   - **Stale (≥ 14 days old)** → treat as cache miss; fall through to full Phase 1 + Phase 2 below.
4. **If not found** → fall through to full Phase 1 + Phase 2 below.
5. **Not eligible (non-recurring)** → skip cache entirely; fall through.

#### Phase 1+2: Full People Note Resolution

For each unique name, resolve the People note using **last-name-first Glob patterns** (`{People Folder}` from invocation parameters):
- **Full name known:** Use `{People Folder}/*[LastName]*.md` — this catches nickname-based filenames (e.g., "Kep Brown.md" for Kenneth Brown). If multiple results, disambiguate by first name.
- **Single name only:** Use `{People Folder}/*[Name]*.md`

**Two-phase execution (MANDATORY — do not interleave):**

1. **Phase 1 — Glob all:** Issue ALL People note Glob calls in a single parallel tool-call batch. Do not read any People note until all Glob results are collected.
2. **Phase 2 — Read all:** Issue ALL resulting Read calls in a single parallel tool-call batch. Extract `full_name`, `nickname`, `role_title`, and `company/org` from each. Build a `Context` value per person: `{role_title}, {company/org}` (omit the comma if one field is empty; leave blank if both are empty).

Build the People context table (the `People Note Filename` column is reused in Step 8 — no re-Globbing):

```
| Full Name | Nickname | Context | People Note Filename | Source |
|-----------|----------|---------|---------------------|--------|
| Michael Chen | Mike | Platform Engineer, Acme Corp | Michael Chen | calendar |
| Jane Smith | Jane | Frontend Lead, Project Alpha | Jane Smith | microphone_user |
```

---

## Step 7: Speaker Identification Analysis

Run the inline LLM analysis using all data gathered in Steps 2-6.

### Input Data

| Source | Data |
|--------|------|
| Transcript body | Full text from Step 2 (speaker labels + timestamps + utterances) |
| Speaker stubs | `speakers` array from frontmatter (name, stub flag, line_count) |
| Calendar attendees | From Step 5 (names, emails, People note matches) |
| People context | From Step 6a (full_name, nickname, context, People Note filename for all candidates) |

### 6 Priority Rules

Apply these rules in order. Higher-priority rules override lower ones. Each rule can assign a speaker name with a confidence level.

#### Rule 1: Microphone Speaker (CERTAIN)

The `Microphone user:` from invocation parameters. Look up in the People context table — always present as a candidate. Assign to the "Microphone" label in the transcript; if absent, assign to the speaker with the most lines. **Confidence:** CERTAIN. **Evidence:** "microphone". Hard rule — never overridden by subsequent rules.

#### Rule 2: Calendar Attendees (CERTAIN or HIGH)

Use calendar attendees from Step 5.

- **Calendar + vocative match** = CERTAIN confidence. (Attendee name appears in calendar AND a vocative for that person is detected in transcript — see Rule 3.)
- **Calendar + single transcript signal** = HIGH confidence. (Attendee in calendar AND one other signal: speaking style, topic expertise, response to vocative.)
- **Calendar alone** without any transcript evidence = **do not assign**. People may be on the invite but not present.

#### Rule 3: Vocative Scanning

Parse the transcript body for vocative patterns — instances where a speaker name is used in direct address:

- `"[Name], go ahead"`
- `"Thanks, [Name]"`
- `"[Name], I think..."`
- `"[Name], what do you think?"`
- `"Good point, [Name]"`
- `"[Name], can you..."`
- `"Over to you, [Name]"`
- `"[Name]?" (calling on someone)`

Match detected vocatives against the People context table:
- **First names** derived from `Full Name` column (first word of full name)
- **Nicknames** from the `Nickname` column

Each vocative detection is a signal. Multiple vocative detections for the same name = stronger signal.

**Unmatched vocative recovery:** If any vocative names do not match candidates in the People context table (first name, nickname, or full name), collect ALL unmatched names first, then issue all recovery Globs in a **single parallel batch**:

```
Glob("{People Folder}/*{name1}*.md")    // all in one batch
Glob("{People Folder}/*{name2}*.md")
```

For each hit, add the person to the candidate pool and apply vocative-response mapping (Rule 4) normally. For misses, flag in evidence as `unmatched_vocative: "{name}"` — may indicate an uninvited attendee or transcription error.

#### Rule 4: Vocative-to-Response Mapping

When a vocative is detected (Rule 3), the speaker who talks **immediately after** being called by name is likely that person.

**Logic:** If Speaker A says "Tom, go ahead" and the next utterance is from Speaker 3, then Speaker 3 is likely Tom.

- Single vocative-response → HIGH confidence (with corroboration from calendar)
- Multiple vocative-responses pointing to the same mapping → CERTAIN confidence
- Conflicting vocative-responses → flag as ambiguous, LOW confidence

#### Rule 5: First Name to Full Name Resolution

When a first name is identified (from vocative or other evidence), resolve to full name:

1. Check calendar attendees first — if exactly one attendee has that first name, use them (calendar context takes precedence for this session)
2. Check People context table (Step 6a) — `Full Name` and `Nickname` columns

**Ambiguity — first-name collision:** When multiple candidates share a first name, attempt disambiguation in order:

1. **Context match:** Check the `Context` column for each candidate. If the transcript discusses a program, team, or organization that matches exactly one candidate's context → resolve to that candidate at **HIGH** confidence (not CERTAIN — circumstantial evidence). **Evidence:** `context_match: "{context value}" aligns with transcript topic "{topic}"`
2. **Calendar attendee preference:** If exactly one candidate is a calendar attendee for this session → resolve to that candidate (existing Rule 2 logic applies).
3. **Neither resolves:** Flag as LOW confidence with all candidates **and their Context values** listed for faster manual resolution. Example: `"John" — candidates: John Keith (Frontend Lead, Project Alpha), John Washburn (Network Engineer, Acme Corp)`

#### Rule 6: Alias / Transcription Error Handling

For each unresolved stub, check `Nickname` column from the People context table for phonetically similar matches to words spoken near that speaker's utterances. **Confidence:** LOW unless corroborated by another signal.

### Confidence Classification

| Level | Criteria |
|-------|----------|
| **CERTAIN** | Microphone user, OR calendar + vocative, OR multiple independent signals all agreeing |
| **HIGH** | Calendar + single signal, OR multiple vocative-responses |
| **LOW** | Single weak signal, phonetic guess, or ambiguous match |

### Build Proposed Mapping

After applying all 6 rules, build the proposed mapping. For each speaker, record:
- `index` — `0` = Microphone, `N` = Speaker N (aligned with stub labels)
- `original_name` — the stub label from the transcript
- `proposed_name` — the resolved full name, or null if unresolved
- `confidence` — CERTAIN, HIGH, or LOW (null if unresolved)
- `evidence` — brief description of the signals used

---

## Step 8: Return Results

Return the proposed mapping in the output format specified by the caller's `Output format:` invocation parameter. Do not write any changes to the transcript — the calling plugin handles user review and file updates.
