

Performance-optimized version of Speaker Auto-Tag Prompt with batched People note resolution and context-based confidence refinement.

Self-contained prompt for tagging unidentified speakers in one transcript stub using vault data (People notes, calendar attendees). Returns proposed speaker mappings — plus optional, conservative diarization-hygiene cleanups detected during the same read. The caller handles review and writes.

**CRITICAL:** Never read the full transcript in a single Read call. Transcripts exceed the 10k token file-read limit. Use chunked reads (limit=500 per chunk). See Step 2.

**OPTIMIZATION FOCUS:** Read People notes deterministically from the parent meeting invitees list (no broad name-based glob), batch all invitee reads in parallel, build a comprehensive context table before analysis, and use role/context matching for confidence refinement.

**DIARIZATION HYGIENE (no added cost):** Open-source diarizers (e.g. those used by transcription apps) make predictable mistakes — they split one person across several labels, collapse several people into one catch-all label, and stamp overlapping speech onto multiple labels. The transcript body is already fully in context for speaker tagging, so Step 6.5 catches the highest-confidence, lowest-risk of these in the **same pass** — **zero extra tool calls, no re-reading, no transcript rewrites on a guess.** This step is bounded and gated (see the `Diarization cleanup` input); it never dominates the run.

**No PII in this prompt.** All names below are fictional placeholders for illustration only. Keep it that way — never paste real attendee names, aliases, or org-specific identifiers into this file.

---

## Step 1: Setup

If Read, Glob, Grep, and Bash are not already available, load them: ToolSearch("select:Read,Glob,Grep,Bash")

Extract from the calling message:
- Transcript — path to the transcript stub file
- Microphone user — full name of the person at the microphone
- Calendar Attendees — pre-fetched attendee context (optional; skips Step 4 if provided)
- People Roster — pre-built People context table (optional; skips Step 3 if provided — use as the People context table directly)
- People Folder — folder name for People notes (default: People)
- Output format — expected output format for the mapping
- Diarization cleanup — `off` | `flag` | `apply` (default: `flag`). Controls Step 6.5. `off` = mapping only, skip hygiene entirely (fastest). `flag` = detect and return cleanup suggestions but propose no edits. `apply` = additionally emit apply-ready edit ops for the **HIGH-confidence, low-risk** classes only (echo de-dup, label-variant unification); merges/splits remain flag-only at every setting.

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
- Glob("Caches/Tagging History/SANITIZED_SUBJECT.md") — historical priors cache for Rule 2.5

If the tagging-history Glob hits, schedule a Read of it (limit=120) alongside the body chunks in Round 2. Extract the per-person table (Person, Transcripts, Common Stubs) and the meeting-level fields (transcripts_observed, first_speaker_tendency). Pass to Step 6 as the **tagging history prior**.

Extract from frontmatter:
- session_id (or macwhisper_session_id for WhisperCal stubs)
- **speaker block** — array of speaker objects with name, id, stub flag, line_count. Read from `speakers:` (MacWhisper-era schema) OR `attendees:` (TOME-era schema), whichever is present as a nested-object list. The two are equivalent — TOME just renamed the field. Note: some TOME files use a *flat-list* `attendees:` (just `- Speaker 2`, `- You` strings); treat that as "no speaker metadata available" and rely on body parsing in Step 2 Round 2.
- meeting_note — wiki-link to parent meeting note (used in Step 3a)
- calendar_event — event title, "none", or absent
- calendar_attendees — array of plain string names (or invitees for WhisperCal, or meeting_invitees for wiki-link format like "- [[Name]]")
- meeting_subject — used to validate cache match
- is_recurring — enables roster cache path
- pipeline_state — current pipeline state
- tags — detect WhisperCal stubs (tags: [transcript])

**Body delimiter format depends on era:** MacWhisper transcripts use `**Name** [HH:MM:SS]` (square brackets); TOME transcripts use `**Name** (HH:MM:SS)` (parens). When scanning the body in Step 5 or counting lines per speaker, accept either: `^\*\*([^*]+)\*\*\s*[\[(](\d{1,2}:\d{2}(?::\d{2})?)[\])]`.

Pipeline state: any value (tagged, extracted, summarized, titled) or absent means proceed.

**Round 2 — transcript body chunks in a single parallel batch.** Use the line count from Round 1. Read in chunks of 500 lines, starting after the frontmatter:
- Read(transcript_path, offset=61, limit=500) — chunk 1
- Read(transcript_path, offset=561, limit=500) — chunk 2
- Read(transcript_path, offset=1061, limit=500) — chunk 3 if needed
- Continue until total lines are covered.

Most transcripts need 1 to 3 chunks. The full body across all chunks is the primary input for Step 6.

---

## Step 3: Read Invitees from Parent Meeting Note (OPTIMIZED)

**Skip this entire step if** `People Roster` was provided in the invocation parameters. Use the provided roster as the People context table directly and proceed to Step 4.

**CRITICAL:** If not skipped, do NOT skip this step. Complete it before Step 4 to maximize cache hits and build context early.

### 3a. Read Parent Meeting Note

The transcript frontmatter contains `meeting_note` field with a wiki-link to the parent meeting note (e.g., `[[2026-04-04 - Test Transcript]]`).

- Extract the meeting note path from the wiki-link
- Read the meeting note (limit=100 to capture frontmatter + invitees section)
- Extract the `meeting_invitees` field — this contains an array of People note wiki-links or plain attendee names

Example invitees field:
```
meeting_invitees:
  - "[[People/Jordan Rivers]]"
  - "[[People/Sam Patel]]"
  - "[[People/Alex Chen]]"
  - "[[People/Mara Lopez]]"
```

Or plain names:
```
meeting_invitees:
  - Jordan Rivers
  - Sam Patel
  - Alex Chen
```

### 3b. Parse Invitees & Build File Paths (DETERMINISTIC)

For each invitee:
- If wiki-link format `[[People/Name]]`: extract the path as `People/Name.md`
- If plain name: construct path as `People/{name}.md`

Issue **ALL** Read calls in a single parallel batch. This is deterministic — no glob phase.

Example (if 4 invitees):
```
Read(People/Jordan Rivers.md, limit=60)
Read(People/Sam Patel.md, limit=60)
Read(People/Alex Chen.md, limit=60)
Read(People/Mara Lopez.md, limit=60)
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

### 3e. Signature Cache Reads (Parallel Batch)

After Phase 3c builds the People context table, issue a single parallel batch:

```
Read("Caches/Speaker Signatures/{Full Name}.md", limit=80)
```

— one Read per invitee in the People context table. Misses are silently skipped (not every invitee will have a signature cache yet). For each hit, extract:
- aliases
- top signature phrases (the bulleted list under `## Signature phrases`)
- typical_meetings

Attach this data to the corresponding row in the People context table as new columns:

| Full Name | Nickname | Role/Context | People Note Filename | Source | Aliases | Signature Phrases |

This data feeds Rule 5.5 in Step 6.

### 3d. Roster Cache Merge (If Cache Hit)

If a cache was found in Step 2:
- Compare table from Phase 3c against cached roster
- If all invitees are present in cache: use cached full context
- If new names found: merge Phase 3c results into cache, update cache generated date

---

## Step 4: Calendar Attendees

Skip if Calendar Attendees was provided in invocation (use it directly). Also skip if People Roster was provided.

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

Collect all unmatched names (e.g., "Kai", "Mara", "Nico", "Jo").

Issue recovery Globs in a single parallel batch:
```
Glob(People Folder/*Kai*.md)
Glob(People Folder/*Mara*.md)
Glob(People Folder/*Nico*.md)
Glob(People Folder/*Jo*.md)
```

For each glob hit:
- Issue a Read in a single parallel batch (Phase 2 repeat)
- Extract full_name, nickname, role_title, company/org
- Add to People context table with Source="vocative_recovery"

For misses: flag the unmatched_vocative in the final evidence field for that speaker.

---

## Step 6: Speaker Identification Analysis

Analyze the full transcript body (from Step 2), speaker stubs (frontmatter), and **complete** People context table (from Step 3c + 5c) using the rules below. Higher-priority rules override lower ones.

**CRITICAL — duplicate assignments are expected and correct.** Transcription engines frequently split one real person across multiple speaker tags (e.g., Speaker 1 and Speaker 3 are both the same person). Propose the best match for each tag independently. Do NOT enforce a one-to-one constraint between people and tags. If the evidence says Speaker 1 is "Jane Doe" and Speaker 3 is also "Jane Doe", propose "Jane Doe" for both.

**CRITICAL — the inverse also happens: several people collapsed into one label.** A single label — often a low-content "Speaker N", or a catch-all that accumulates many short acknowledgments — may contain turns from two or more real people. When a label is mixed, do NOT cement the collapse by stamping a confident single name on it (see Rule 7). Forcing a wrong single name is worse than leaving it `mixed`/`null`: downstream summaries will misattribute everything under that label.

**Label-variant unification.** Two *different* labels that are obviously the same person — name-spelling variants ("Steve"/"Steven", "Alex"/"Alexander", "Mike"/"Michael"), or a generic "Speaker N" that the evidence ties to a person already named under another label — should resolve to ONE canonical full name. Pick the fullest correct form (prefer the People-note `full_name`) and map every variant label to it. Record the variants unified (the `canonical` field in Build Proposed Mapping) so the caller can normalize the body. This is free — the labels are already in front of you — and it is the single most common diarization defect.

### Rule 1: Microphone Speaker — CERTAIN

Assign the Microphone user only when there is an explicit "Microphone" speaker stub (MacWhisper transcripts have this — the mic channel is a separate speaker). Evidence: "microphone". Never overridden.

If no "Microphone" stub exists (TOME, Call Recording, generic "Speaker N" stubs), do NOT guess the microphone user from line count or any other heuristic. Identify the microphone user only through the same signals used for any other invitee (Rules 2–6). Line count is not evidence of microphone identity — the most talkative speaker is often the host or a vendor, not the recorder.

### Rule 2: Calendar Attendees — CERTAIN or HIGH

- Calendar + vocative match (see Rule 3) = CERTAIN
- Calendar + one other transcript signal (style, topic expertise, vocative response) = HIGH
- Calendar alone with no transcript evidence = do not assign. Invitees may be absent.

### Rule 2.5: Historical Stub Continuity — CERTAIN or HIGH

When a Tagging History cache is provided for this meeting subject (loaded in Step 2):

- If a stub (e.g., "Speaker 1") matches a person in that cache's `Common Stubs` column with **≥80%** frequency (count for that stub ÷ that person's `Transcripts`) AND that person is in the People context table (calendar or invitee): **CERTAIN**. Evidence: `"history: <person> in N/M prior <subject>"`.
- **60–79%** frequency + that person is in the People context table: **HIGH**. Evidence: same shape.
- **<60%** frequency: weak signal — do not upgrade on this alone. May still corroborate other rules.

Special case: if `first_speaker_tendency` in the cache names a person and that person is in the People context table, treat as supporting evidence for the Speaker who appears first chronologically in the transcript body.

### Rule 3: Vocative Scanning & Matching

Vocatives matched in Step 5 now resolve to full names via the People context table.

- Vocative directly matches a single People note = CERTAIN or HIGH
- Multiple independent vocatives resolve to same person = CERTAIN
- Unmatched vocative (recovery failed) = flag but do not assign

### Rule 4: Vocative-to-Response Mapping

The speaker who talks immediately after being called by name is likely that person. If Speaker A says "Mara, go ahead" and Speaker 3 speaks next, Speaker 3 is likely Mara.

- Multiple vocative-responses for the same mapping = CERTAIN
- Single vocative-response = HIGH
- Conflicting mappings = LOW

### Rule 5: First Name to Full Name Resolution + Context Matching (OPTIMIZED)

Resolve first names to full names:

1. Check calendar attendees — if exactly one has that first name, use them.
2. Check People context Full Name and Nickname columns.

**First-name collision (multiple candidates share first name): try disambiguation in order:**

1. **Context match** (NEW) — if transcript topic/discussion matches one candidate's Role/Context value, resolve at HIGH confidence with evidence "role/context match: [Context]"
   - Example: Speaker discusses "VMware patching" and context table has "Jordan Avery - VMware Administrator, Platform Team" → HIGH match
   - Example: Speaker discusses "observability deployment" and context table has "Sam Rivera - SRE, Platform Team" and "Sam Lin - Finance" → HIGH match to Rivera

2. Calendar preference — if exactly one candidate is a calendar attendee, use them.
3. Neither resolves — flag as LOW with all candidates and their Context values listed.

### Rule 5.5: Signature Phrase Match — CERTAIN or HIGH

When Signature Caches are loaded into the People context table (Step 3e):

- If a speaker's transcript blocks contain a top signature phrase from an invitee's signature cache (case-insensitive substring match) AND that invitee is in the People context table:
  - **2+ distinct signature phrases match the same invitee**: **CERTAIN**. Evidence: `"signature: <phrase1>, <phrase2>"`.
  - **1 signature phrase match**: **HIGH**. Evidence: `"signature: <phrase>"`.
- Combine multiplicatively with Rule 2.5: a history-prior match (≥60%) + any signature-phrase match for the same person = **CERTAIN**, even without a vocative.

The `Aliases` column from Step 3e can also resolve unmatched vocatives in Rule 3 — a vocative matching an alias resolves as if it matched the Full Name.

### Rule 6: Alias / Transcription Error Handling

For unresolved stubs, check Nicknames for phonetically similar matches to words spoken near that speaker. Confidence: LOW unless corroborated by Role/Context.

### Rule 7: Mixed / Catch-all Labels — do not force a single identity

A label is *mixed* when, within its own blocks, you see clear evidence of more than one real speaker:
- a question and its own answer inside one block, or an answer to a question the same label just asked (self-Q&A)
- a greeting/response pair under one label ("you there?" → "yeah, I'm here")
- "Thanks, <Name>" / "Go ahead, <Name>" / "Over to you, <Name>" followed by a *different* person continuing under the same label — **especially common at the START of a block in round-robin standups, where the host's handoff cue is baked onto the next speaker's first turn** (e.g. a block that opens "Thanks, sir. Dana." and then continues with Dana's actual update — the cue is the host, the rest is Dana)
- a first-person topic-ownership flip ("my team will…" → "well, from our side…")
- the label is dominated by short backchannels ("yeah", "mm-hmm", "right", "okay") that plainly come from several different voices

Handling:
- If one person clearly owns the *substantive* content and the remainder is short backchannel/overlap → map to that person, set `mixed: true`, confidence at most HIGH, evidence noting the contamination.
- If two or more people genuinely share the substantive content → set `proposed_name: null`, `mixed: true`, confidence LOW, and emit a `flag_merge` cleanup (Step 6.5) with the suspected split point and candidate names. **Do NOT auto-split the body.**

This rule is the primary defense against the most damaging diarization failure (many speakers → one attribution): it refuses to launder a merge into a single confident name.

### Confidence Levels (REFINED)

- **CERTAIN:** microphone user, calendar + vocative, multiple vocative-responses, multiple independent signals agreeing, **history ≥80% + invitee present, 2+ signature phrases + invitee present, or history-prior (≥60%) + any signature phrase match**
- **HIGH:** calendar + single signal, single vocative-response, vocative + context match, calendar + role/context alignment, **history 60–79% + invitee present, or single signature phrase + invitee present**
- **LOW:** single weak signal, phonetic guess, ambiguous match, or unresolved collision
- **null:** no evidence found

### Build Proposed Mapping

For each speaker, record:
- index — 0 for Microphone, N for Speaker N
- original_name — stub label from transcript
- proposed_name — resolved full name, or null (the same person may appear for multiple tags — this is correct)
- canonical — the unified full name when this label is a spelling/variant of another label (Label-variant unification); omit if the label stands alone
- mixed — true when this label contains more than one real speaker (Rule 7); omit/false otherwise
- confidence — CERTAIN, HIGH, LOW, or null if unresolved
- evidence — brief signal description (include "role/context match: [matching field]" if used)

Do not downgrade confidence or skip a match because the same person was already proposed for a different tag. Evaluate each tag on its own evidence.

---

## Step 6.5: Diarization Hygiene (bounded, gated)

**Skip entirely if `Diarization cleanup` = `off`.** Otherwise run this as part of the analysis you already did in Step 6 — **issue no new tool calls and do not re-read the transcript.** This is pattern-spotting over text already in context; spend a light pass, not a deep re-analysis.

You are detecting predictable diarizer mistakes and proposing *conservative* fixes. Two classes are safe enough to auto-apply (when `apply`); the rest are advisory flags at every setting. **Never delete real speech, never rewrite block text, never split a body block on a guess.**

**Detect these classes** (each becomes one entry in `diarization_cleanups`):

1. **`unify_label`** *(auto-apply eligible — HIGH)* — Variant labels that are the same person (mirrors Label-variant unification in Step 6). Fields: `from_labels` (list), `to_name`, `reason`. This is the highest-value, lowest-risk fix.

2. **`drop_echo`** *(auto-apply eligible — HIGH)* — The *same* short utterance (normalized text, ≤ ~6 words) appears in 2+ adjacent blocks within ~1.5s, typically across *different* labels (overlap bleed, e.g. the same "sorry, can you repeat that?" stamped on three speakers). Keep one occurrence — prefer the block whose label matches the surrounding turn — and drop the duplicates. Fields: `lines` (lines to drop), `keep_line`, `text`, `confidence`, `reason`. Only flag exact/near-exact repeats; never collapse two people who happen to both say "yeah".

3. **`merge_block`** *(flag only by default; auto-apply only if both labels already resolve to the same `proposed_name`)* — One sentence split mid-clause across two adjacent blocks with *different* labels and a sub-second gap, clearly one continuous speaker. Fields: `lines` (the two blocks), `to_label`, `confidence`, `reason`.

4. **`flag_merge`** *(flag only — never auto-applied)* — A label that contains two or more real speakers (Rule 7). Fields: `label`, `split_after` (line after which the speaker appears to change), `suspected_speakers` (candidate names from the People context table), `reason`. The caller or a human decides; this prompt does not rewrite.

5. **`flag_backchannel_catchall`** *(flag only — informational)* — A label that is mostly short backchannels from several voices. One entry **per label**, not per backchannel block. Fields: `label`, `reason`. Backchannels are real speech — they are a *signal* feeding Rule 7, never content to delete.

**Bounding (protects speed + token budget):**
- Do **not** enumerate individual backchannel blocks — report only the label-level `flag_backchannel_catchall`.
- Cap the list at the ~20 highest-confidence entries. If more exist, return the total count and a one-line note instead of the full list.
- If `Diarization cleanup` = `flag`, emit all classes but mark every entry advisory (no edits applied by the caller).
- If a clean transcript yields nothing, return an empty `diarization_cleanups` list — do not invent issues.

---

## Step 7: Return Results

Return the mapping in the output format specified by the caller. When `Diarization cleanup` ≠ `off`, also return a `diarization_cleanups` array (the Step 6.5 entries; empty if none). Keep the two outputs separate so a caller that only wants the mapping can ignore the cleanups.

**Do not write changes to the transcript.** This prompt only *proposes* — the caller reviews and writes. Apply-eligible ops (`unify_label`, `drop_echo`, and `merge_block` only when both labels share one `proposed_name`) are safe for the caller to apply automatically under `apply`; `flag_merge` and `flag_backchannel_catchall` always require review.

---

## Caching & Performance Notes

**Roster Cache Strategy:**
- Cache is eligible if meeting_subject exists AND is_recurring is true
- Cached People context remains valid for 14 days
- On cache hit: skip Step 3 Phase 2 reads entirely (major time savings)
- On cache miss or new names: merge results into cache for future runs

**Tagging History Cache (read-only here):**
- Located at `Caches/Tagging History/{SANITIZED_SUBJECT}.md`
- Built and refreshed by `Prompts/Speaker Cache Rebuild.md` — this prompt only reads
- Provides per-meeting behavioral priors: which person has occupied each stub historically, modal first speaker
- Feeds Rule 2.5 in Step 6

**Speaker Signature Cache (read-only here):**
- Located at `Caches/Speaker Signatures/{Full Name}.md` — basename matches the People note
- Built and refreshed by `Prompts/Speaker Cache Rebuild.md` — this prompt only reads
- Provides per-person linguistic priors: signature phrases, aliases, typical meetings. Aliases include the person's nickname or initials (e.g., "JR" for Jordan Rivers) — match these against names spoken in the transcript body as a primary identification signal.
- Read in Step 3e in a single parallel batch keyed off the People context table
- Feeds Rule 5.5 in Step 6 (and the alias bridge in Rule 3)

**Tool Call Batching Summary:**
- Step 2: 3 parallel calls (Read transcript frontmatter, wc, Glob roster cache) + transcript body chunks in parallel
- Step 3: Read parent meeting note → Parse invitees → Read all invitee People notes in parallel (deterministic, no glob)
- Step 5c: Recovery Glob batch (vocative recovery only) → Wait → Recovery Read batch (if needed)
- Step 6.5: **0 tool calls** — reuses the transcript body already in context; never re-reads
- Total batches: ~4-5 (vs ~10+ in non-optimized version; eliminates broad name-based glob phase)

**Expected Impact:**
- With fresh People context build: 1-2 minute baseline
- With roster cache hit: 30-40% faster (skips Phase 2 reads)
- With context matching: 15-20% fewer unresolved speakers vs. non-optimized
- Diarization hygiene (Step 6.5): negligible time cost (no I/O); output stays small because backchannels are reported per-label and the list is capped. Set `Diarization cleanup: off` to remove even the reasoning cost.
