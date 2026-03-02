# Speaker Auto-Tag Prompt

Standalone prompt for tagging unidentified speakers in a single transcript stub. Invokes the macwhisper skill directly in the current agent context — no Task agent spawn, no summarization pipeline.

**Invocation pattern:**
```
claude --dangerously-skip-permissions 'Follow the instructions in /abs/path/Speaker Auto-Tag Prompt.md. Transcript: Transcripts/2026-03-02 - Team Sync - Transcript.md. Microphone user: Dan Loomis.'
```

---

## Step 1: Parse Invocation Parameters

Extract from the calling message:
- `Transcript:` → path to the transcript stub file
- `Microphone user:` → full name of the person speaking into the microphone

**Vault root:** Determine from the absolute path of this prompt file by stripping the filename and any `Prompts/` suffix. For example, if the prompt is at `/vault/Prompts/Speaker Auto-Tag Prompt.md`, the vault root is `/vault`.

**Path resolution:** Try the path as-is first. If not found, prepend vault root and try again. If still not found, error with: "Transcript file not found: [path]. Check the path and try again."

---

## Step 2: Read Transcript Stub

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

**Error conditions:**
- File does not exist → error as described in Step 1
- File has no frontmatter (no `---` delimiters) → error: "File has no YAML frontmatter. Is this a transcript stub?"
- No `session_id` or `macwhisper_session_id` field → error: "No session ID found in frontmatter. Cannot run auto-tag."

---

## Step 3: Pipeline State Check

Read `pipeline_state` from stub frontmatter:

- `pipeline_state: tagged` or `extracted` or `summarized` → warn user:
  ```
  This transcript is already tagged (pipeline_state: [value]). Re-run speaker auto-tag anyway?
  ```
  Use AskUserQuestion with options "Re-run" / "Cancel". Stop if user selects Cancel.
- `pipeline_state: titled` or absent → proceed.

---

## Step 4: Model Recommendation

Inform the user:
> **Note:** Opus is recommended for speaker auto-tagging (better reasoning for ambiguous speakers). Proceeding with the current model — switch to Opus for best results if speaker count is high or names are ambiguous.

Do not block on this — continue regardless of current model.

---

## Step 5: Calendar Attendees

All attendee data comes from the transcript stub frontmatter — no external calendar queries are performed.

Check the stub for attendee fields in this order:

1. **`invitees`** — WhisperCal stubs use this field (array of plain name strings). Use directly.
2. **`calendar_attendees`** — standard pipeline field (array of plain name strings). Use directly.
3. **Neither present, or both empty** — proceed without attendee context. Note this to the user: "No attendee list found in stub — proceeding with speaker audio analysis only."

When attendees are available, build a context table for the macwhisper skill:
```
Calendar Attendees:
| Name |
|------|
| Jane Smith |
| John Doe |
```

---

## Step 6: People Context (Optional Enrichment)

Glob `People/*.md` for files matching stub speaker names or calendar attendee names.

For each match, read the note and extract `full_name`, `nickname`, and any `derived_names` fields.

Build a People context table:
```
| Full Name | Nickname | Derived Names | Source |
|-----------|----------|---------------|--------|
| Jane Smith | Jane | Jane S | People note |
```

Skip gracefully if no matches — auto-tag still works via global roster and vocatives from within the macwhisper skill.

---

## Step 7: Invoke macwhisper Skill

Use the **Skill tool** to invoke the macwhisper skill. The skill runs its full 7-step auto-tag workflow in the current agent context (no Task agent spawn).

Determine the session ID to use:
- Use `session_id` if present
- Fall back to `macwhisper_session_id` (WhisperCal stubs)

Pass the `speakers` array from the stub frontmatter to the skill to avoid re-discovery.

**Skill invocation:**
```
Skill("macwhisper"): "Auto-tag untagged speakers for session [SESSION_ID]. Microphone user: [Microphone User Full Name].

Speakers from stub (use these — no re-discovery needed):
[speakers array from frontmatter, formatted as a list]

[If calendar attendees are available:]
[Calendar Attendees context table from Step 5]

[If People context is available:]
[People context table from Step 6]

[If running on Sonnet:]
Note: Opus is recommended for speaker auto-tag. If confidence is low on any speaker, consider switching models and re-running."
```

The macwhisper skill will:
1. Find stubs for the session
2. Gather context (roster, vocatives, global names)
3. Run LLM analysis
4. Build a confidence-ranked mapping
5. Present the mapping to the user for approval
6. Write approved names to the MacWhisper DB
7. Verify the writes

Wait for the skill to complete and user to approve the mapping before proceeding.

---

## Step 8: Update Transcript Stub

After the macwhisper skill confirms DB writes, update the transcript stub frontmatter using the **Edit tool** (never Write — preserves all existing fields).

**Fields to update:**

1. **Speaker names:** For each speaker resolved by auto-tag:
   - Update `name` to the resolved name
   - Set `stub: false`
   - Add `confidence: [HIGH/MEDIUM/LOW]` field
   - Add `evidence: "[evidence string from skill output]"` field

2. **Confirmed speakers:** Build `confirmed_speakers` list:
   - For each resolved speaker (stub: false), search `People/*.md` for a matching filename (Glob `People/*[LastName]*.md`)
   - If found, add `"[[People Note Filename]]"` (use exact filename, not speaker name — they may differ)
   - Speakers with no matching People note are omitted from this list (remain in `speakers[]`)

3. **Pipeline state:** Set `pipeline_state: tagged`

**Edit strategy:** Make a single Edit call that replaces the relevant frontmatter block. If the speakers array is large, make targeted edits per speaker. Always confirm the edit succeeds before reporting completion.

---

## Step 9: Report Results

Summarize to the user:

```
Speaker auto-tag complete for: [transcript filename]

Resolved speakers:
- [Name] (HIGH confidence — [evidence])
- [Name] (MEDIUM confidence — [evidence])

Unresolved:
- Speaker N ([X] lines) — kept as stub

Stub updated: pipeline_state → tagged
```

If any speakers remain as stubs, ask: "Unresolved speakers remain. Proceed to summarization anyway, or re-run auto-tag with additional context?"
