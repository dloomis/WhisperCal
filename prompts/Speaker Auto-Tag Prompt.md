# Speaker Auto-Tag Prompt

Self-contained prompt for tagging unidentified speakers in one transcript stub using vault data (People notes, calendar attendees). Returns proposed speaker mappings; the caller handles review and writes.

**CRITICAL:** Never read the full transcript in a single Read call. Transcripts exceed the 10k token file-read limit. Use chunked reads (limit=500 per chunk). See Step 2.

**OPTIMIZATION FOCUS:** Read People notes deterministically from the parent meeting invitees list (no broad name-based glob), batch all invitee reads in parallel, build a comprehensive context table before analysis, and use role/context matching for confidence refinement.

---

## Step 1: Setup

If Read, Glob, Grep, and Bash are not already available, load them: ToolSearch("select:Read,Glob,Grep,Bash")

Extract from the calling message:
- Transcript — path to the transcript stub file
- Microphone user — full name of the person at the microphone
- Calendar Attendees — full invitee name list provided by the plugin at runtime (skips Step 4)
- People Roster — pre-built People context table provided by the plugin at runtime (skips Step 3 — use as the People context table directly)
- People Folder — folder name for People notes (default: People)
- Output format — expected output format for the mapping

Path resolution: try the Transcript path as-is. If not found, error with the path.

Vault root derivation: extract vault root from the transcript path by removing the transcript folder suffix. Use this root combined with People Folder for all lookups.

Derived values (from filename, no read needed):
- MEETING_TITLE — strip date prefix (first 13 chars for "YYYY-MM-DD - " or first 11 chars for "YYYY-MM-DD ") and " - Transcript" suffix
- SANITIZED_SUBJECT — take MEETING_TITLE, replace /, \, : with hyphens. Used for cache Glob in Step 2.

---

## Step 2: Read Transcript + Glob Roster Cache + Glob People Notes

**Round 1 — issue in a single parallel batch:**
- Read(transcript_path, limit=60) — frontmatter only
- Bash: wc -l transcript_path — total line count
- Glob("Caches/Speaker Rosters/SANITIZED_SUBJECT.md") — roster cache for Step 5

Extract from frontmatter:
- session_id (or macwhisper_session_id for WhisperCal stubs)
- speakers — array with name, id, stub flag, line_count per speaker
- meeting_note — wiki-link to parent meeting note (used in Step 3a)
- calendar_event — event title, "none", or absent
- calendar_attendees — array of plain string names (or invitees for WhisperCal, or meeting_invitees for wiki-link format like "- [[Name]]")
- meeting_subject — used to validate cache match
- is_recurring — enables roster cache path
- pipeline_state — current pipeline state
- tags — detect WhisperCal stubs (tags: [transcript])

Pipeline state: any value (tagged, extracted, summarized, titled) or absent means proceed.

**Round 2 — transcript body chunks in a single parallel batch.** Use the line count from Round 1. Read in chunks of 500 lines, starting after the frontmatter:
- Read(transcript_path, offset=61, limit=500) — chunk 1
- Read(transcript_path, offset=561, limit=500) — chunk 2
- Read(transcript_path, offset=1061, limit=500) — chunk 3 if needed
- Continue until total lines are covered.

Most transcripts need 1 to 3 chunks. The full body across all chunks is the primary input for Step 6.

---

## Step 3: Read Invitees from Parent Meeting Note (FALLBACK)

**Default behavior:** The plugin provides `People Roster` at runtime. Use it as the People context table directly and skip to Step 4.

**Fallback (no People Roster provided):** Read invitees from the parent meeting note. Complete this before Step 4 to maximize cache hits and build context early.

### 3a. Read Parent Meeting Note

The transcript frontmatter contains `meeting_note` field with a wiki-link to the parent meeting note (e.g., `[[2026-04-04 - Test Transcript]]`).

- Extract the meeting note path from the wiki-link
- Read the meeting note (limit=100 to capture frontmatter + invitees section)
- Extract the `meeting_invitees` field — this contains an array of People note wiki-links or plain attendee names

Example invitees field:
```
meeting_invitees:
  - "[[People/Joe Jackson]]"
  - "[[People/Tanner Bragg]]"
  - "[[People/Gregory Porter]]"
  - "[[People/Andrew Davis]]"
```

Or plain names:
```
meeting_invitees:
  - Joe Jackson
  - Tanner Bragg
  - Gregory Porter
```

### 3b. Parse Invitees & Build File Paths (DETERMINISTIC)

For each invitee:
- If wiki-link format `[[People/Name]]`: extract the path as `People/Name.md`
- If plain name: construct path as `People/{name}.md`

Issue **ALL** Read calls in a single parallel batch. This is deterministic — no glob phase.

Example (if 4 invitees):
```
Read(People/Joe Jackson.md, limit=60)
Read(People/Tanner Bragg.md, limit=60)
Read(People/Gregory Porter.md, limit=60)
Read(People/Andrew Davis.md, limit=60)
```

### 3c. Build People Context Table (Phase 2)

From each People note read in Phase 3b, extract:
- full_name
- nickname (if present)
- role_title
- company/org

Build a Context value per person as:
- `"role_title, company/org"` (both present)
- `"role_title"` (org empty)
- `"company/org"` (role empty)
- `""` (both empty)

Build a People context table with these fields per person:
| Full Name | Nickname | Role/Context | People Note Filename | Source |

Source values: "meeting_invitee", "calendar", "microphone_user", "vocative_recovery"

**This table is the foundation for Step 6 confidence refinement. Do not skip to Step 4 until this is complete.**

### 3d. Roster Cache Merge (If Cache Hit)

If a cache was found in Step 2:
- Compare table from Phase 3c against cached roster
- If all invitees are present in cache: use cached full context
- If new names found: merge Phase 3c results into cache, update cache generated date

---

## Step 4: Calendar Attendees

**Default behavior:** The plugin provides `Calendar Attendees` at runtime. Use the provided list directly.

**Fallback (no Calendar Attendees provided):**

- calendar_event is "none" — skip calendar lookups entirely (ad-hoc meeting)
- calendar_attendees, invitees, or meeting_invitees populated — use directly (strip [[ ]] wrappers if present)
- No calendar data — proceed without. Calendar context improves confidence but is not required.

Add all calendar attendees to the People context table from Step 3c with Source="calendar".

---

## Step 5: Vocative-to-Speaker Mapping

### 5a. Vocative Scanning (Pre-Step 6)

Scan the full transcript body (from Step 2) for direct address patterns:
- "[Name], go ahead"
- "Thanks, [Name]"
- "[Name], what do you think?"
- "[Name], can you..."
- "Over to you, [Name]"
- "[Name]?" (standalone calling)

### 5b. Match Against People Context

For each vocative detected, check the People context table (Step 3c):
- Match against Full Name (exact or first word)
- Match against Nickname
- Multiple detections for the same name strengthen signal

### 5c. Unmatched Vocative Recovery Batch (OPTIMIZED)

If any vocative names do not match People context:

Collect all unmatched names (e.g., "Kev", "Chew", "Alex", "Joe").

Issue recovery Globs in a single parallel batch:
```
Glob(People Folder/*Kev*.md)
Glob(People Folder/*Chew*.md)
Glob(People Folder/*Alex*.md)
Glob(People Folder/*Joe*.md)
```

For each glob hit:
- Issue a Read in a single parallel batch (Phase 2 repeat)
- Extract full_name, nickname, role_title, company/org
- Add to People context table with Source="vocative_recovery"

For misses: flag the unmatched_vocative in the final evidence field for that speaker.

---

## Step 6: Speaker Identification Analysis

Analyze the full transcript body (from Step 2), speaker stubs (frontmatter), and **complete** People context table (from Step 3c + 5c) using the rules below. Higher-priority rules override lower ones.

### Rule 1: Microphone Speaker — CERTAIN

Assign the Microphone user to the "Microphone" label. If no "Microphone" label exists, assign to the speaker with the most lines. Evidence: "microphone". Never overridden.

### Rule 2: Calendar Attendees — CERTAIN or HIGH

- Calendar + vocative match (see Rule 3) = CERTAIN
- Calendar + one other transcript signal (style, topic expertise, vocative response) = HIGH
- Calendar alone with no transcript evidence = do not assign. Invitees may be absent.

### Rule 3: Vocative Scanning & Matching

Vocatives matched in Step 5 now resolve to full names via the People context table.

- Vocative directly matches a single People note = CERTAIN or HIGH
- Multiple independent vocatives resolve to same person = CERTAIN
- Unmatched vocative (recovery failed) = flag but do not assign

### Rule 4: Vocative-to-Response Mapping

The speaker who talks immediately after being called by name is likely that person. If Speaker A says "Tom, go ahead" and Speaker 3 speaks next, Speaker 3 is likely Tom.

- Multiple vocative-responses for the same mapping = CERTAIN
- Single vocative-response = HIGH
- Conflicting mappings = LOW

### Rule 5: First Name to Full Name Resolution + Context Matching (OPTIMIZED)

Resolve first names to full names:

1. Check calendar attendees — if exactly one has that first name, use them.
2. Check People context Full Name and Nickname columns.

**First-name collision (multiple candidates share first name): try disambiguation in order:**

1. **Context match** (NEW) — if transcript topic/discussion matches one candidate's Role/Context value, resolve at HIGH confidence with evidence "role/context match: [Context]"
   - Example: Speaker discusses "VMware patching" and context table has "Gregory Kanis - VMware Administrator, Platform Team" → HIGH match
   - Example: Speaker discusses "observability deployment" and context table has "Tanner Bragg - SRE, Platform Team" and "Tanner Smith - Finance" → HIGH match to Bragg

2. Calendar preference — if exactly one candidate is a calendar attendee, use them.
3. Neither resolves — flag as LOW with all candidates and their Context values listed.

### Rule 6: Alias / Transcription Error Handling

For unresolved stubs, check Nicknames for phonetically similar matches to words spoken near that speaker. Confidence: LOW unless corroborated by Role/Context.

### Confidence Levels (REFINED)

- **CERTAIN:** microphone user, calendar + vocative, multiple vocative-responses, or multiple independent signals agreeing
- **HIGH:** calendar + single signal, single vocative-response, vocative + context match, or calendar + role/context alignment
- **LOW:** single weak signal, phonetic guess, ambiguous match, or unresolved collision
- **null:** no evidence found

### Build Proposed Mapping

For each speaker, record:
- index — 0 for Microphone, N for Speaker N
- original_name — stub label from transcript
- proposed_name — resolved full name, or null
- confidence — CERTAIN, HIGH, LOW, or null if unresolved
- evidence — brief signal description (include "role/context match: [matching field]" if used)

---

## Step 7: Return Results

Return the mapping in the output format specified by the caller. Do not write changes to the transcript.

---

## Caching & Performance Notes

**Roster Cache Strategy:**
- Cache is eligible if meeting_subject exists AND is_recurring is true
- Cached People context remains valid for 14 days
- On cache hit: skip Step 3 Phase 2 reads entirely (major time savings)
- On cache miss or new names: merge results into cache for future runs

**Tool Call Batching Summary:**
- Step 2: 3 parallel calls (Read transcript frontmatter, wc, Glob roster cache) + transcript body chunks in parallel
- Step 3: Read parent meeting note → Parse invitees → Read all invitee People notes in parallel (deterministic, no glob)
- Step 5c: Recovery Glob batch (vocative recovery only) → Wait → Recovery Read batch (if needed)
- Total batches: ~4-5 (vs ~10+ in non-optimized version; eliminates broad name-based glob phase)

**Expected Impact:**
- With fresh People context build: 1-2 minute baseline
- With roster cache hit: 30-40% faster (skips Phase 2 reads)
- With context matching: 15-20% fewer unresolved speakers vs. non-optimized
