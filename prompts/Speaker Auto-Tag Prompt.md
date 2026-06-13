

Tags unidentified speakers in one transcript stub using vault data (People notes, calendar attendees, signature/history caches). Returns proposed speaker mappings, plus optional conservative diarization-hygiene cleanups detected in the same read. The caller reviews and writes; this prompt only proposes.

The plugin caller now identifies enrolled people acoustically (voiceprints) before invoking this prompt, and runs it only as a fallback. When it passes **Voiceprint Matches**, those labels are already confirmed — treat them as fixed CERTAIN anchors and concentrate the analysis on the labels that remain unidentified.

**CRITICAL:** Never read the full transcript in a single Read call. Transcripts exceed the 10k token file-read limit. Use chunked reads (limit=500 per chunk). See Step 2.

**Optimization focus:** read People notes deterministically from the parent meeting invitees (no broad name-based glob), batch reads in parallel, and build the People context table before analysis.

**No PII in this prompt.** All names below are fictional placeholders for illustration only. Never paste real attendee names, aliases, or org-specific identifiers into this file.

---

## Step 1: Setup

If Read, Glob, Grep, and Bash are not already available, load them: ToolSearch("select:Read,Glob,Grep,Bash")

Extract from the calling message:
- Transcript — path to the transcript stub file
- Microphone user — full name of the person at the microphone
- Transcripts Folder — folder containing transcript files (optional); use for path resolution instead of guessing
- People Folder — folder name for People notes (default: People)
- Calendar Attendees — pre-fetched attendee context (optional; skips Step 4 if provided)
- People Roster — pre-built People context table (optional; skips the Step 3 invitee reads — use as the People context table directly). Columns: `| Full Name | Nickname | Context | People Note Filename | Source |`
- Prior Speakers — names confirmed in prior transcripts of the same meeting (optional, Processor 20). Add each to the People context table with Source="prior_speaker".
- Voiceprint Matches — label→full-name pairs the plugin already confirmed acoustically (optional, plugin fallback path only). Format: `Speaker 2 = Sarah Patel; Speaker 5 = Mike Cho`. Each is CERTAIN and fixed: never re-derive or override its identity (Rule 0). Add each to the People context table as an anchor (Source="voiceprint"), use those names to help pin the unmatched labels, and concentrate the identification analysis on the labels NOT in this list. Still emit a row for each matched label in the output (see Step 7).
- Additional instructions — free-text hints from the user (optional, manual runs), e.g. who was present. Treat as high-priority evidence.
- batch — when true (Processor 20), run non-interactively and return proposals only.
- Output format — expected output schema for the mapping (see Step 7).
- Diarization cleanup — `off` | `flag` | `apply` (default: `off`). Controls Step 6.5. `off` = mapping only, skip hygiene entirely. `flag` = detect and return cleanup suggestions but propose no edits. `apply` = additionally emit apply-ready edit ops for the HIGH-confidence, low-risk classes only (echo de-dup, label-variant unification); merges/splits stay flag-only at every setting. Rule 7 (mixed labels) stays active regardless of this setting, since it affects the mapping itself.

Path resolution: try the Transcript path as-is. If not found, error with the path.

Vault root derivation: strip the transcript folder suffix from the transcript path. Combine that root with People Folder for all lookups.

Derived values (from filename, no read needed):
- MEETING_TITLE — strip date prefix (first 13 chars for "YYYY-MM-DD - " or first 11 chars for "YYYY-MM-DD ") and " - Transcript" suffix
- SANITIZED_SUBJECT — MEETING_TITLE with /, \, : replaced by hyphens. Used for the Tagging History cache Glob in Step 2.

---

## Step 2: Read Transcript + Caches

**Round 1 — issue in a single parallel batch:**
- Read(transcript_path, limit=200) — frontmatter (real frontmatter regularly exceeds 60 lines; the fields needed most, `meeting_note`/`pipeline_state`/`meeting_subject`/`is_recurring`/`meeting_invitees`/`tags`, sit at the bottom)
- Bash: `awk '/^---$/{c++; if(c==2) print "fm_end=" NR} END{print "total=" NR}' transcript_path` — returns the frontmatter boundary (`fm_end`) and total line count (`total`) in one call
- Glob("Caches/Tagging History/SANITIZED_SUBJECT.md") — historical priors cache for Rule 2.5
- (Processor 20 path only, and only when no People Roster was provided) Read the parent meeting note — see Step 3a; folding it here saves a round trip.

If the closing `---` is past line 200, issue a follow-up Read for the remainder using `fm_end` before parsing the speaker block.

If the tagging-history Glob hits, schedule a Read of it (limit=120) alongside the Round 2 body chunks. Extract the per-person table (Person, Transcripts, Common Stubs) and the meeting-level fields (transcripts_observed, first_speaker_tendency). Pass to Step 6 as the **tagging history prior**.

Extract from frontmatter:
- session_id (or macwhisper_session_id for WhisperCal stubs)
- **speaker block** — array of speaker objects with name, id, stub flag, line_count. Read from `speakers:` (MacWhisper-era schema) OR `attendees:` (TOME-era schema), whichever is present as a nested-object list. The two are equivalent — TOME renamed the field. Some TOME files use a *flat-list* `attendees:` (just `- Speaker 2`, `- You` strings); treat that as "no speaker metadata available" and rely on body parsing from Round 2.
- meeting_note — wiki-link to parent meeting note (used in Step 3a)
- calendar_event — event title, "none", or absent
- calendar_attendees — array of plain string names (or `invitees` for WhisperCal, or `meeting_invitees` for wiki-link format like "- [[Name]]")
- meeting_subject, is_recurring, pipeline_state, tags (tags: [transcript] marks a WhisperCal stub)

**Body delimiter formats (three eras, accept all):** MacWhisper `**Name** [HH:MM:SS]` (square brackets); TOME meeting `**Name** (HH:MM:SS)` and `(M:SS)` (parens); TOME call `**Name** (seconds.millis)`, e.g. `(13.515)`. When scanning the body or counting lines per speaker, use:
```
^\*\*([^*]+)\*\*\s*[\[(](\d{1,2}:\d{2}(?::\d{2})?|\d+\.\d+)[\])]
```

Pipeline state: any value (tagged, extracted, summarized, titled) or absent means proceed.

**Round 2 — transcript body chunks in a single parallel batch.** Read in chunks of 500 lines, starting after the frontmatter at `fm_end + 1`, computing each subsequent offset from `total`:
- Read(transcript_path, offset=fm_end+1, limit=500) — chunk 1
- Read(transcript_path, offset=fm_end+501, limit=500) — chunk 2
- continue until `total` lines are covered

Most transcripts need 1 to 3 chunks. The full body across all chunks is the primary input for Step 6.

**Fold into Round 2 (same batch, no extra round trip):**
- the Tagging History Read (if its Glob hit)
- the signature-cache Read batch — see Step 3b. When a People Roster is provided this is the ONLY way signature caches get read, so do not skip it; key the Reads off the roster's "People Note Filename" column.

---

## Step 3: Build People Context Table

**If `People Roster` was provided:** use it directly as the People context table. Skip 3a and the invitee Reads in 3b. Still issue the signature-cache Read batch (folded into Round 2 above) keyed off the roster filenames, and still run 3c to fold in Prior Speakers and any other sources. Then go to Step 4.

Otherwise build the table from the parent meeting note.

### 3a. Parent meeting note

The transcript frontmatter's `meeting_note` field holds a wiki-link to the parent note (e.g. `[[2026-04-04 - Test Transcript]]`).
- Derive the meeting note path by stripping " - Transcript" from the transcript filename; every observed `meeting_note` matches this. On the Processor 20 path, Read it (limit=120) in Round 1 speculatively. If it misses or the frontmatter `meeting_note` disagrees, Read the correct file in Round 2.
- Extract `meeting_invitees` — an array of People note wiki-links or plain names. Example:
```
meeting_invitees:
  - "[[People/Jordan Rivers]]"   # or plain: - Jordan Rivers
  - "[[People/Sam Patel]]"
  - "[[People/Mara Lopez]]"
```

### 3b. Read invitee People notes + signature caches (one parallel batch)

For each invitee, build a path: wiki-link `[[People/Name]]` → `People/Name.md`; plain name → `People Folder/{name}.md`. Issue all invitee Reads (limit=60) plus all signature-cache Reads in a single parallel batch — the signature filenames equal the People-note basenames and are known before any People note is read, so they cost no extra round trip.

```
Read(People/Jordan Rivers.md, limit=60)
Read(People/Sam Patel.md, limit=60)
Read(Caches/Speaker Signatures/Jordan Rivers.md, limit=80)
Read(Caches/Speaker Signatures/Sam Patel.md, limit=80)
```

**Recover People-note read misses.** Calendar display names often differ from People note filenames (formal first names, middle initials), and invitee lists can include non-person entries (team/group wikilinks). Collect every failed People-note Read, then issue one parallel Glob batch `People Folder/*{LastName}*.md` for the misses, then one parallel Read batch for the Glob hits. Names that still miss get a context-less row (no error).

Signature-cache misses are silently skipped (not every person has one yet). For each signature-cache hit, extract aliases, the top signature phrases (bullets under `## Signature phrases`), and typical_meetings.

### 3c. Assemble the table

From each People note extract full_name, nickname, role_title, company/org. Build a Context value: `"role_title, company/org"`, or whichever single field is present, or `""` if both empty. Build the table:

| Full Name | Nickname | Role/Context | People Note Filename | Source | Aliases | Signature Phrases |

Source values: "meeting_invitee", "calendar", "microphone_user", "prior_speaker", "vocative_recovery", "voiceprint". Add any Prior Speakers passed in as Source="prior_speaker" rows, and any Voiceprint Matches as Source="voiceprint" anchor rows (the label bound to its confirmed full name) so those names are available to vocative and response mapping. The Aliases/Signature Phrases columns come from 3b and feed Rules 3 and 5.5. This table is the foundation for Step 6 confidence refinement — complete it before Step 4.

---

## Step 4: Calendar Attendees

Skip if Calendar Attendees was provided in the invocation (use it directly), or if People Roster was provided.
- `calendar_event: none` → skip calendar lookups entirely (ad-hoc meeting)
- `calendar_attendees` / `invitees` / `meeting_invitees` populated → use directly (strip `[[ ]]` wrappers)
- no calendar data → proceed without; calendar context improves confidence but is not required

Dedupe calendar attendees case-insensitively (nickname-aware) against names already in the table — invitees and calendar attendees are largely the same people — then add only the new ones with Source="calendar".

---

## Step 5: Vocative-to-Speaker Mapping

### 5a. Vocative scanning

Scan the full transcript body (Step 2) for direct-address patterns: "[Name], go ahead", "Thanks, [Name]", "[Name], what do you think?", "[Name], can you…", "Over to you, [Name]", standalone "[Name]?".

### 5b. Match against People context

For each vocative, check the People context table: match against Full Name (exact or first word), Nickname, or Aliases. Multiple detections for the same name strengthen the signal.

### 5c. Unmatched vocative recovery batch

For vocatives that match nothing, collect the unmatched names. **Only attempt recovery for names of at least 3 characters** — shorter fragments over-match the folder badly; skip them and just flag. Issue recovery Globs in a single parallel batch:
```
Glob(People Folder/*Mara*.md)
Glob(People Folder/*Nico*.md)
```
For each hit, Read it (single parallel batch), extract full_name/nickname/role_title/company-org, and add to the table with Source="vocative_recovery". For misses (and for skipped short fragments): flag the unmatched_vocative in that speaker's evidence field.

---

## Step 6: Speaker Identification Analysis

Analyze the full transcript body (Step 2), the speaker stubs (frontmatter), and the complete People context table (Steps 3 + 5c) using the rules below. Higher-priority rules override lower ones.

**Duplicate assignments are expected and correct.** Diarizers frequently split one real person across multiple labels (Speaker 1 and Speaker 3 are the same person). Propose the best match for each label independently; do NOT enforce one-to-one. If the evidence says both are "Jane Doe", propose "Jane Doe" for both.

**The inverse also happens — several people collapsed into one label.** A low-content "Speaker N" or a catch-all of short acknowledgments may hold turns from two or more people. When a label is mixed, do not cement the collapse with a confident single name; see Rule 7. A wrong single name is worse than `null`, because downstream summaries misattribute everything under it.

**Label-variant unification.** Two *different* labels that are obviously the same person (spelling variants like "Steve"/"Steven", or a generic "Speaker N" the evidence ties to a person already named under another label) resolve to ONE canonical full name (prefer the People-note `full_name`). Record the variants unified so the caller can normalize the body. This is the single most common diarization defect and is free to catch.

### Rule 0: Voiceprint-confirmed labels — CERTAIN, fixed
When **Voiceprint Matches** are provided, each listed label is already confirmed acoustically by the caller. Treat it as CERTAIN and immutable: never re-derive, downgrade, or override its identity, and spend no analysis budget on it. Use these confirmed names as anchors for every rule below — a confirmed label's vocatives, handoffs ("go ahead, Mike"), and responses help pin the *unmatched* labels (Rules 3-5). A confirmed label is also a valid canonical target for Label-variant unification: an unmatched "Speaker N" the evidence ties to a confirmed person resolves to that person. Concentrate all identification effort on the labels NOT in this list. (Absent the field — Processor 20, manual runs — this rule is inert and everything proceeds as before.)

### Rule 1: Microphone speaker — CERTAIN
- An explicit "Microphone" stub (MacWhisper mic channel) → the Microphone user. Evidence: "microphone". Never overridden.
- A stub named "You" (TOME call recordings label the recording user's channel `**You**`) → the Microphone user, CERTAIN. Evidence: "microphone (You = recording user)". Output `original_name: "You"` unchanged (name-based merge).
- For any other label (generic "Speaker N", etc.) do NOT guess the microphone user from line count or any heuristic. Identify them only via Rules 2-6; the most talkative speaker is often the host or a vendor, not the recorder.

### Rule 2: Calendar attendees — CERTAIN or HIGH
- Calendar + vocative match (Rule 3) = CERTAIN
- Calendar + one other transcript signal (style, topic expertise, vocative response) = HIGH
- Calendar alone, no transcript evidence = do not assign (invitees may be absent)

### Rule 2.5: Historical stub continuity — CERTAIN or HIGH
When a Tagging History cache is provided for this meeting subject (Step 2):
- A stub matches a person in that cache's `Common Stubs` column with **≥80%** frequency (count for that stub ÷ that person's `Transcripts`) AND that person is in the People context table → **CERTAIN**. Evidence: `"history: <person> in N/M prior <subject>"`.
- **60-79%** + that person in the table → **HIGH**, same evidence shape.
- **<60%** → weak; do not upgrade alone, may corroborate other rules.

Special case: if `first_speaker_tendency` names a person in the People context table, treat as supporting evidence for the speaker who appears first chronologically.

### Rule 3: Vocative scanning & matching
Vocatives matched in Step 5 resolve to full names via the People context table (including the Aliases column — a vocative matching an alias resolves as if it matched the Full Name).
- Vocative matches a single People note = CERTAIN or HIGH
- Multiple independent vocatives → same person = CERTAIN
- Unmatched vocative (recovery failed) = flag, do not assign

### Rule 4: Vocative-to-response mapping
The speaker who talks immediately after being called by name is likely that person (Speaker A says "Mara, go ahead" and Speaker 3 speaks next → Speaker 3 is likely Mara).
- Multiple vocative-responses for the same mapping = CERTAIN
- Single vocative-response = HIGH
- Conflicting mappings = LOW

### Rule 5: First name to full name + context matching
Resolve first names: check calendar attendees (if exactly one matches, use them), then the table's Full Name and Nickname columns.

On a first-name collision (multiple candidates), disambiguate in order:
1. **Context match** — if the transcript topic matches one candidate's Role/Context value, resolve at HIGH with evidence "role/context match: [Context]" (e.g. a speaker discussing "observability deployment" matches "Sam Rivera - SRE, Platform Team" over "Sam Lin - Finance").
2. **Calendar preference** — if exactly one candidate is a calendar attendee, use them.
3. Neither resolves → LOW, listing all candidates and their Context values.

### Rule 5.5: Signature phrase match — CERTAIN or HIGH
When signature caches are loaded into the table (Step 3b):
- A speaker's blocks contain a top signature phrase from an invitee's signature cache (case-insensitive substring) AND that invitee is in the table:
  - **2+ distinct phrases → same invitee** = **CERTAIN**. Evidence: `"signature: <phrase1>, <phrase2>"`.
  - **1 phrase** = **HIGH**. Evidence: `"signature: <phrase>"`.
- Combine multiplicatively with Rule 2.5: a history prior (≥60%) + any signature-phrase match for the same person = **CERTAIN**, even without a vocative.

### Rule 6: Alias / transcription-error handling
For unresolved stubs, check Nicknames for phonetically similar matches to words spoken near that speaker. Confidence: LOW unless corroborated by Role/Context.

### Rule 7: Mixed / catch-all labels — do not force a single identity
A label is *mixed* when, within its own blocks, you see clear evidence of more than one real speaker:
- a question and its own answer in one block, or an answer to a question the same label just asked (self-Q&A)
- a greeting/response pair under one label ("you there?" → "yeah, I'm here")
- "Thanks, <Name>" / "Over to you, <Name>" followed by a *different* person continuing under the same label — **especially at the START of a block in round-robin standups, where the host's handoff cue is baked onto the next speaker's first turn** (a block opening "Thanks, sir. Dana." then continuing with Dana's update — the cue is the host, the rest is Dana)
- a first-person topic-ownership flip ("my team will…" → "well, from our side…")
- the label is dominated by short backchannels ("yeah", "mm-hmm", "right", "okay") plainly from several voices

Handling:
- One person clearly owns the *substantive* content, remainder is short backchannel/overlap → map to that person, set `mixed: true`, confidence at most HIGH, evidence noting the contamination.
- Two or more genuinely share the substantive content → `proposed_name: null`, `mixed: true`, confidence LOW, and emit a `flag_merge` cleanup (Step 6.5) with the suspected split point and candidate names. **Do NOT auto-split the body.**

This is the primary defense against the most damaging diarization failure (many speakers → one attribution): it refuses to launder a merge into a single confident name.

### Confidence levels
- **CERTAIN:** voiceprint-confirmed label (Rule 0), microphone user, calendar + vocative, multiple vocative-responses, multiple agreeing signals, history ≥80% + invitee present, 2+ signature phrases + invitee present, or history prior (≥60%) + any signature phrase
- **HIGH:** calendar + single signal, single vocative-response, vocative + context match, calendar + role/context alignment, history 60-79% + invitee present, or single signature phrase + invitee present
- **LOW:** single weak signal, phonetic guess, ambiguous match, unresolved collision
- **null:** no evidence found

Do not downgrade or skip a match because the same person was already proposed for another label. Evaluate each label on its own evidence.

---

## Step 6.5: Diarization Hygiene (bounded, gated)

**Skip entirely if `Diarization cleanup` = `off` (the default).** Otherwise run this within the Step 6 analysis you already did — **issue no new tool calls and do not re-read the transcript.** This is pattern-spotting over text already in context: a light pass, not a deep re-analysis. **Never delete real speech, never rewrite block text, never split a block on a guess.**

Each detection becomes one entry in `diarization_cleanups`:

1. **`unify_label`** *(auto-apply eligible — HIGH)* — Variant labels that are the same person (mirrors Label-variant unification in Step 6). Fields: `from_labels` (list), `to_name`, `reason`. Highest value, lowest risk.
2. **`drop_echo`** *(auto-apply eligible — HIGH)* — The *same* short utterance (normalized text, ≤ ~6 words) appears in 2+ adjacent blocks within ~1.5s, usually across *different* labels (overlap bleed). Keep one occurrence (prefer the block whose label matches the surrounding turn), drop the rest. Fields: `lines`, `keep_line`, `text`, `confidence`, `reason`. Only exact/near-exact repeats; never collapse two people who both say "yeah".
3. **`merge_block`** *(flag only by default; auto-apply only if both labels already resolve to the same `proposed_name`)* — One sentence split mid-clause across two adjacent blocks with *different* labels and a sub-second gap, clearly one speaker. Fields: `lines` (the two blocks), `to_label`, `confidence`, `reason`.
4. **`flag_merge`** *(flag only — never auto-applied)* — A label containing two or more real speakers (Rule 7). Fields: `label`, `split_after`, `suspected_speakers` (candidates from the People context table), `reason`. A human or the caller decides.
5. **`flag_backchannel_catchall`** *(flag only — informational)* — A label that is mostly short backchannels from several voices. One entry **per label**, not per block. Fields: `label`, `reason`. Backchannels are real speech and a signal for Rule 7, never content to delete.

**Bounding:** do not enumerate individual backchannel blocks (report only the label-level flag); cap the list at the ~20 highest-confidence entries (if more exist, return the total count and a one-line note); under `flag`, mark every entry advisory; a clean transcript returns an empty list — do not invent issues.

---

## Step 7: Return Results

**When the caller specifies an Output format, return exactly that schema and nothing else** — no extra fields, no prose outside it.

The plugin (primary caller) specifies:
> Return ONLY a fenced JSON code block: `{"speakers":[{"index":0,"original_name":"...","proposed_name":"...or null","confidence":"CERTAIN|HIGH|LOW|null","evidence":"..."}]}`. No other text.

Honoring it:
- `original_name` MUST be the frontmatter speaker name **verbatim** (e.g. "Speaker 2", "You", "Microphone") — never the unified or corrected form. The caller merges by `original_name`; a normalized value silently orphans the proposal.
- For a label listed in **Voiceprint Matches**, still emit its row: `proposed_name` = the confirmed full name, `confidence: "CERTAIN"`, `evidence: "voiceprint"`. Do not omit it (the caller's modal builds its speaker list from this output, so an omitted label disappears) and do not re-analyze it.
- Fold canonical/mixed/merge findings into the `evidence` text. A genuinely mixed label still gets `proposed_name: null`, LOW confidence (Rule 7).
- Do not emit `canonical`, `mixed`, or `diarization_cleanups` under this schema — the plugin's parser ignores unknown fields and forbids extra output.

**Default output (no Output format given, some Processor 20 runs):** a markdown table, one row per speaker:
- index — 0 for Microphone, N for Speaker N
- original_name — stub label from the transcript, verbatim
- proposed_name — resolved full name, or null (the same person may appear for multiple labels — correct)
- canonical — the unified full name when this label is a variant of another (Label-variant unification); omit if it stands alone
- mixed — true when this label holds more than one real speaker (Rule 7); omit/false otherwise
- confidence — CERTAIN, HIGH, LOW, or null
- evidence — brief signal description (include "role/context match: [field]" if used)

When `Diarization cleanup` ≠ `off`, also return a `diarization_cleanups` array (the Step 6.5 entries; empty if none), kept separate from the mapping so a caller that only wants the mapping can ignore it.

**Do not write changes to the transcript.** This prompt only *proposes*; the caller reviews and writes. Apply-eligible ops (`unify_label`, `drop_echo`, and `merge_block` only when both labels share one `proposed_name`) are safe for the caller to apply automatically under `apply`; `flag_merge` and `flag_backchannel_catchall` always require review.

---

## Caching & Performance Notes

Caches read here are read-only in this prompt; both are built and refreshed by `Prompts/Speaker Cache Rebuild.md`.

- **Tagging History** — `Caches/Tagging History/{SANITIZED_SUBJECT}.md`. Per-meeting behavioral priors (which person has occupied each stub historically, modal first speaker). Feeds Rule 2.5.
- **Speaker Signatures** — `Caches/Speaker Signatures/{Full Name}.md` (basename matches the People note). Per-person linguistic priors: signature phrases, aliases (nickname/initials, e.g. "JR" for Jordan Rivers), typical meetings. Read in Step 3b in the Round 2 batch. Feeds Rule 5.5 and the alias bridge in Rule 3.

**Tool-call batching:**
- Round 1: frontmatter Read + awk (boundary + total) + Tagging History Glob (+ parent meeting note Read on the Processor 20 path).
- Round 2: body chunks + invitee/signature Reads + Tagging History Read (one parallel batch).
- Step 3b miss path: one Glob batch + one Read batch, only for People-note misses.
- Step 5c: recovery Glob batch then Read batch, only when unmatched vocatives ≥3 chars exist.
- Step 6.5: 0 tool calls — reuses the body already in context.

Typical run is 2 batches (Round 1, Round 2), plus the conditional recovery batches when needed.
