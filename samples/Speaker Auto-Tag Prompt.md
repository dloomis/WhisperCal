# Speaker Auto-Tag Prompt

Self-contained prompt for tagging unidentified speakers in a single transcript stub. Runs the full 7-rule speaker identification algorithm using vault data (People notes, calendar attendees, prior transcripts) — no MacWhisper DB interaction.

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
- `People Roster:` — pre-built context table (skips Steps 6a-6c entirely)
- `Prior Speakers:` — pre-fetched prior transcript speakers (skips Step 6b)
- `Transcripts Folder:` — folder name for transcript files (default: `Transcripts`)
- `People Folder:` — folder name for People notes (default: `People`)

---

## Step 0: Pre-load Tools

Before any processing, load all required tools in a single call to avoid sequential tool discovery overhead:

```
ToolSearch("select:Read,Glob,Grep")
```

---

## Step 1: Parse Invocation Parameters

Extract from the calling message:
- `Transcript:` → path to the transcript stub file
- `Microphone user:` → full name of the person speaking into the microphone
- `Calendar Attendees:` → pre-fetched attendee context table (optional — skips Step 5 if provided)
- `People Roster:` → pre-built People context table (optional — skips Steps 6a-6c if provided)
- `Prior Speakers:` → pre-fetched prior transcript speakers (optional — skips Step 6b if provided)
- `Transcripts Folder:` → folder name for transcript files (optional — defaults to `Transcripts`)
- `People Folder:` → folder name for People notes (optional — defaults to `People`)
- `Output format:` → the expected output format for the proposed mapping (provided by the caller)

**Path resolution:** Try the `Transcript:` path as-is first. If not found, error with: "Transcript file not found: [path]. Check the path and try again."

**Vault root derivation:** Extract the vault root from the transcript path by removing the `{Transcripts Folder}/...` suffix (using the provided or default folder name). Use this derived root combined with `{Transcripts Folder}/` and `{People Folder}/` for all subsequent lookups.

---

## Step 2: Read Transcript Stub + Glob Prior Transcripts

**Parallelization opportunity:** The meeting base name can be derived from the transcript *filename* (strip the date prefix — first 13 chars for `YYYY-MM-DD - ` or first 11 chars for `YYYY-MM-DD `). This means the prior transcript Glob (Step 6b) does not depend on reading the file. Issue the transcript Read and the prior transcript Glob in the **same parallel tool-call batch**:

```
Read(transcript_path)                                          // Step 2
Glob("{Transcripts Folder}/*BASE_NAME* - Transcript.md")       // Step 6b early
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
- **`calendar_attendees` or `invitees` populated** → use directly (WhisperCal stubs map `invitees` as plain strings)
- **No calendar data from any source** → proceed without; calendar context improves confidence but is not required

---

## Step 6: Speaker Candidate Roster

**Skip this entire step if** `People Roster:` was provided in the invocation parameters. Use the provided roster as the People context table directly and proceed to Step 7.

Build the speaker candidate roster from two vault-native sources. This is the primary enrichment step — all data comes from the vault.

### 6b. Recurring Meeting Speakers (from prior transcripts)

**Skip if** `Prior Speakers:` was provided in the invocation parameters. Use the provided speaker list directly.

The prior transcript Glob was already issued in Step 2 (parallel with the transcript Read). Use those results here.

Sort by date prefix (descending), take top 2 (excluding the current transcript). **Read both in parallel** (single batch of Read calls). **Do NOT set a line limit** — speaker arrays and confirmed_speakers lists routinely push frontmatter past 130 lines; a conservative limit causes extra read rounds. Extract `confirmed_speakers` and collect all unique speaker names. Skip gracefully if no prior transcripts exist.

### 6c. People Context Table

Collect all unique names from: stub speakers (frontmatter), calendar attendees (Step 5), and recurring meeting speakers (6b).

#### 6c-cache: Roster Cache Check

**Priority order:** `People Roster:` parameter (highest — skips 6a-6c entirely) > cache hit (skips Phase 1+2 Globs/Reads below) > full rebuild (existing behavior).

Before running the expensive Phase 1+2 Glob/Read cycle, check for a cached roster:

1. **Eligibility:** Transcript has `meeting_subject` AND (`is_recurring: true` OR the Step 2 Glob returned 2+ prior transcripts for this series).
2. **Lookup:** Glob `Caches/Speaker Rosters/{sanitized_subject}.md` where `sanitized_subject` replaces filesystem-unsafe characters (`/`, `\`, `:`) with hyphens.
3. **If found, Read it.** Check the `generated` frontmatter field:
   - **Fresh (< 14 days old):** Compare current candidate names (from stubs + calendar + prior speakers collected above) against the cached roster's `Full Name` column.
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
| Tom Wilson | Tom | | Tom Wilson | prior_transcript |
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
| Recurring meeting speakers | From Step 6b (`confirmed_speakers` from prior transcripts) |
| People context | From Step 6c (full_name, nickname, context, People Note filename for all candidates) |

### 7 Priority Rules

Apply these rules in order. Higher-priority rules override lower ones. Each rule can assign a speaker name with a confidence level.

#### Rule 1: Microphone Speaker (CERTAIN)

The `Microphone user:` from invocation parameters. Look up in the People context table — always present as a candidate. Assign to the "Microphone" label in the transcript; if absent, assign to the speaker with the most lines. **Confidence:** CERTAIN. **Evidence:** "microphone". Hard rule — never overridden by subsequent rules.

#### Rule 2: Calendar Attendees (CERTAIN or HIGH)

Use calendar attendees from Step 5.

- **Calendar + vocative match** = CERTAIN confidence. (Attendee name appears in calendar AND a vocative for that person is detected in transcript — see Rule 4.)
- **Calendar + single transcript signal** = HIGH confidence. (Attendee in calendar AND one other signal: speaking style, topic expertise, response to vocative.)
- **Calendar alone** without any transcript evidence = **do not assign**. People may be on the invite but not present.

#### Rule 3: Recurring Meeting Speakers (confidence boost)

People from Step 6b (prior transcript `confirmed_speakers`) get a **soft boost** to confidence:
- If a candidate from these sources also has a vocative or transcript signal → bump confidence one level (LOW → HIGH, HIGH → CERTAIN)
- These sources alone are NOT sufficient for assignment — they narrow the candidate pool but require corroborating evidence

#### Rule 4: Vocative Scanning

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

#### Rule 5: Vocative-to-Response Mapping

When a vocative is detected (Rule 4), the speaker who talks **immediately after** being called by name is likely that person.

**Logic:** If Speaker A says "Tom, go ahead" and the next utterance is from Speaker 3, then Speaker 3 is likely Tom.

- Single vocative-response → HIGH confidence (with corroboration from calendar or meeting candidates)
- Multiple vocative-responses pointing to the same mapping → CERTAIN confidence
- Conflicting vocative-responses → flag as ambiguous, LOW confidence

#### Rule 6: First Name to Full Name Resolution

When a first name is identified (from vocative or other evidence), resolve to full name:

1. Check calendar attendees first — if exactly one attendee has that first name, use them (calendar context takes precedence for this session)
2. Check People context table (Step 6c) — `Full Name` and `Nickname` columns

**Ambiguity — first-name collision:** When multiple candidates share a first name, attempt disambiguation in order:

1. **Context match:** Check the `Context` column for each candidate. If the transcript discusses a program, team, or organization that matches exactly one candidate's context → resolve to that candidate at **HIGH** confidence (not CERTAIN — circumstantial evidence). **Evidence:** `context_match: "{context value}" aligns with transcript topic "{topic}"`
2. **Calendar attendee preference:** If exactly one candidate is a calendar attendee for this session → resolve to that candidate (existing Rule 2 logic applies).
3. **Neither resolves:** Flag as LOW confidence with all candidates **and their Context values** listed for faster manual resolution. Example: `"John" — candidates: John Keith (Frontend Lead, Project Alpha), John Washburn (Network Engineer, Acme Corp)`

#### Rule 7: Alias / Transcription Error Handling

For each unresolved stub, check `Nickname` column from the People context table for phonetically similar matches to words spoken near that speaker's utterances. **Confidence:** LOW unless corroborated by another signal.

### Confidence Classification

| Level | Criteria |
|-------|----------|
| **CERTAIN** | Microphone user, OR calendar + vocative, OR multiple independent signals all agreeing |
| **HIGH** | Calendar + single signal, OR recurring speaker + vocative, OR multiple vocative-responses |
| **LOW** | Single weak signal, phonetic guess, or ambiguous match |

### Build Proposed Mapping

After applying all 7 rules, build the proposed mapping. For each speaker, record:
- `index` — `0` = Microphone, `N` = Speaker N (aligned with stub labels)
- `original_name` — the stub label from the transcript
- `proposed_name` — the resolved full name, or null if unresolved
- `confidence` — CERTAIN, HIGH, or LOW (null if unresolved)
- `evidence` — brief description of the signals used

---

## Step 8: Return Results

Return the proposed mapping in the output format specified by the caller's `Output format:` invocation parameter. Do not write any changes to the transcript — the calling plugin handles user review and file updates.
