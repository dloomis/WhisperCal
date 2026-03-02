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

Determine the calendar attendee source using the following decision tree (mirrors Processor 20 Step 2a-ii):

### Case A: `calendar_event: none` in stub
Skip all calendar lookups. Auto-tag will proceed without calendar context (ad-hoc/unscheduled meeting). Note this to the user.

### Case B: `calendar_attendees` or `invitees` already populated in stub
Use the existing attendee list directly. No m365 queries needed.

**WhisperCal stubs** (`tags: [transcript]`): Map `invitees` → calendar attendees (plain strings). No additional lookup needed — WhisperCal integrates calendar data during stub creation.

Skip to Step 6.

### Case C: No `calendar_event` field in stub (lookup not yet performed)
Query both Exchange calendars via the **m365 skill**. Build a time window from the session's `Date` field:
- Window start: session start − 30 minutes
- Window end: session start + `duration` seconds (or + 60 min if duration is unknown)

```bash
# Primary calendar — with attendees
m365 request \
  --url "https://graph.microsoft.com/v1.0/me/calendarView?\$select=subject,start,end,organizer,attendees&startDateTime=<window_start>&endDateTime=<window_end>&\$filter=isCancelled eq false&\$top=20" \
  --method get

# C2E Leadership calendar — with attendees
m365 request \
  --url "https://graph.microsoft.com/v1.0/me/calendars/AAMkADY1ZmI2M2I2LWNmNGQtNGNmMC1iMDU4LTFkMDk0MzY3NjA5MQBGAAAAAABADBoib4-MQZGBz1VcA3sYBwCOC3ekpVNATI-X10SFXCXkAAAAAAEGAACOC3ekpVNATI-X10SFXCXkAANl0f4nAAA=/calendarView?\$select=subject,start,end,organizer,attendees&startDateTime=<window_start>&endDateTime=<window_end>&\$filter=isCancelled eq false&\$top=20" \
  --method get
```

**Date format:** `startDateTime=2026-03-02T08:30:00` (local time, no Z suffix).

Run both calendar calls in parallel.

**Match the session to a calendar event:**
1. Strip date prefix from session title (first 11 chars: `YYYY-MM-DD `)
2. Case-insensitive substring match or word overlap between cleaned session title and event subject
3. If only one event overlaps the time window → accept it
4. If no title match but time window overlap exists → present choices to user via AskUserQuestion
5. If no match at all → set `calendar_event: none` in context; proceed without attendees

**Build attendee context table (when match found):**
1. Extract `attendees` array from Graph API response
2. Derive names from emails when `name` field is just an email address: split local part on `.` / `_`, drop tokens like `ctr`, `mil`, `us`, `org`, drop numeric suffixes, title-case
3. Filter out distribution lists and non-person addresses (`*team@*`, `*group.calendar*`, `*-team@*`)
4. Deduplicate by lowercase name
5. Cap at 20 attendees
6. Cross-reference last names against `People/*.md` (Glob `People/*[LastName]*.md`) for `full_name` and `nickname`

Format as:
```
Calendar Attendees (from event: '<matched event title>'):
| Name | Email | People Note | Nickname |
|------|-------|-------------|----------|
| Alexander Hernandez | alexander.hernandez.ctr@... | [[Alex Hernandez]] | Alex |
| JODICE, LAUREL A Lt Col | laurel.a.jodice@... | (none) | - |
```

**Graceful degradation:** If m365 fails or returns no events, log the error, note "Proceeding without calendar context," and continue.

---

## Step 6: People Context (Optional Enrichment)

Glob `People/*.md` for files matching stub speaker names or calendar attendee names.

For each match, read the note and extract `full_name`, `nickname`, and any `derived_names` fields.

Build a People context table:
```
| Full Name | Nickname | Derived Names | Source |
|-----------|----------|---------------|--------|
| Alexander Hernandez | Alex | Alex H | People note |
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

2. **Calendar data (Case C only — newly fetched in Step 5):**
   - If a calendar event was matched: add `calendar_event: "[event title]"` and `calendar_attendees:` list
   - If no calendar match was found: add `calendar_event: none`
   - Skip if stub already had `calendar_event` field (Cases A and B)

3. **Confirmed speakers:** Build `confirmed_speakers` list:
   - For each resolved speaker (stub: false), search `People/*.md` for a matching filename (Glob `People/*[LastName]*.md`)
   - If found, add `"[[People Note Filename]]"` (use exact filename, not speaker name — they may differ)
   - Speakers with no matching People note are omitted from this list (remain in `speakers[]`)
   - `calendar_attendees` is NOT modified

4. **Pipeline state:** Set `pipeline_state: tagged`

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
