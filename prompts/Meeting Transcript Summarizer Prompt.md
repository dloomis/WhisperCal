# Meeting Transcript Summarizer Prompt

Standalone prompt for summarizing a meeting transcript and writing the summary into the meeting note. Reads the meeting note to find the linked transcript, extracts content, generates a structured summary, and writes it back into the meeting note.

**Invocation pattern:**
```
claude --dangerously-skip-permissions 'Follow the instructions in /abs/path/Meeting Transcript Summarizer Prompt.md. Meeting note: Meetings/2026-03-05 - Weekly CMB Meeting.md.'
```

---

## Step 1: Parse Invocation Parameters

Extract from the calling message:
- `Meeting note:` → vault-relative path to the meeting note file

**Vault root:** Determine from the absolute path of this prompt file by stripping the filename and any `Prompts/` suffix. For example, if the prompt is at `/vault/Prompts/Meeting Transcript Summarizer Prompt.md`, the vault root is `/vault`.

**Path resolution:** Try the path as-is first. If not found, prepend vault root and try again. If still not found, error with: "Meeting note not found: [path]. Check the path and try again."

---

## Step 2: Read Meeting Note

Use the **Read tool** to open the meeting note. All meeting metadata (subject, date, times, invitees) is already in the frontmatter — the LLM sees it directly when reading the file.

The only fields you need to explicitly extract and act on:

| Field | Purpose |
|-------|---------|
| `transcript` | Wiki-link to follow (e.g. `[[Transcripts/...]]`) |
| `pipeline_state` | Gate check in Step 4 |
| `is_recurring` | Meeting type detection in Step 5 |

**Error conditions:**
- File does not exist → error as described in Step 1
- No `transcript` field in frontmatter → error: "Meeting note has no linked transcript. Link a recording first."

**Resolve transcript:** Strip `[[` and `]]` from the transcript link, then read the transcript file.

---

## Step 3: Read Transcript

Use the **Read tool** to open the transcript file. Extract from frontmatter:

| Field | Notes |
|-------|-------|
| `speakers` | Array with name, id, confidence, evidence per speaker |
| `pipeline_state` | Current transcript pipeline state |
| `confirmed_speakers` | Array of People note links for confirmed speakers |
| `meeting_note` | Backlink to the meeting note |

Read the full transcript body content — this is the source material for summarization.

**Identify the microphone user:** Find the speaker entry where `evidence` contains `microphone` or where `original_name` is `Microphone`. That speaker is the user who recorded the meeting.

---

## Step 4: Pipeline State Check

Read `pipeline_state` from the **meeting note** frontmatter:

- `pipeline_state: summarized` → warn user:
  ```
  This meeting has already been summarized (pipeline_state: summarized). Re-run summarization anyway?
  ```
  Use AskUserQuestion with options "Re-run" / "Cancel". Stop if user selects Cancel.
- `pipeline_state: titled` → warn user:
  ```
  Speakers have not been tagged yet (pipeline_state: titled). Summarization works best with tagged speakers. Proceed anyway?
  ```
  Use AskUserQuestion with options "Proceed" / "Cancel". Stop if user selects Cancel.
- `pipeline_state: tagged` → proceed normally.

---

## Step 5: Analyze Meeting Context

Before summarizing, gather context:

1. **Meeting type detection:** Determine from subject line and attendee count:
   - 1:1 meeting (2 attendees)
   - Small group (3-5 attendees)
   - Large meeting (6+ attendees)
   - Recurring meeting (check `is_recurring` in meeting note frontmatter)

2. **Speaker roles:** Map speakers to their roles based on People notes (if `confirmed_speakers` links exist, read those notes for role/title information).

3. **Microphone user perspective:** The summary should be written from the perspective of the microphone user — they are the note-taker. Identify what they said, what was directed at them, and what action items they were assigned.

---

## Step 6: Generate Summary

Create a structured summary with these sections:

### Summary Structure

```markdown
## Summary

[2-4 sentence executive summary of the meeting. Lead with the most important outcome or decision. Written in past tense.]

## Key Decisions

- [Decision 1 — who decided, what was decided]
- [Decision 2]

## Action Items

- [ ] [Action item for microphone user] — assigned to me
- [ ] [Action item for another person] — assigned to [Name]
- [ ] [Action item with deadline] — assigned to [Name], due [date if mentioned]

## Discussion Notes

[Organized by topic, not chronologically. Each topic gets a brief paragraph summarizing the key points discussed. Use speaker names to attribute important statements.]

### [Topic 1]
[Summary of discussion on this topic]

### [Topic 2]
[Summary of discussion on this topic]
```

### Summary Guidelines

- **Be concise:** Each section should capture the essence, not transcribe the conversation
- **Attribute decisions:** Always note who made or approved a decision
- **Action items must be specific:** Include what, who, and when (if mentioned)
- **Use speaker names:** Reference speakers by their tagged names, not "Speaker 1"
- **Microphone user = "me"/"I":** When listing action items for the microphone user, use first person
- **Skip small talk:** Don't include greetings, weather chat, or off-topic banter
- **Preserve technical details:** Keep specific numbers, dates, names, and technical terms accurate
- **Flag uncertainty:** If the transcript is unclear on a point, note it with [unclear] rather than guessing

### Quality Checklist

Before writing the summary, verify:
- [ ] Every action item has an owner
- [ ] Key decisions are captured with context
- [ ] No important topics from the transcript are missing
- [ ] Speaker attributions are accurate
- [ ] The microphone user's action items are clearly marked

---

## Step 7: Write Summary to Meeting Note

Use the **Edit tool** to insert the summary into the meeting note.

**Placement:** Insert the summary content after the frontmatter closing `---` and any existing template content (like attendee lists or meeting metadata). If the note already has a `## Summary` section, replace it entirely.

**Strategy:**
1. Read the current meeting note content
2. Find the insertion point (after frontmatter and any header/metadata sections)
3. If a `## Summary` section exists, replace everything from `## Summary` to the next `## ` heading at the same level (or end of file)
4. If no summary exists, insert after the last frontmatter/template section
5. Use a single Edit call to write the summary

---

## Step 8: Update Pipeline State

After successfully writing the summary:

1. **Meeting note:** Set `pipeline_state: summarized` in the meeting note frontmatter using the Edit tool
2. **Transcript:** Set `pipeline_state: summarized` in the transcript frontmatter using the Edit tool

**Edit strategy:** Make targeted frontmatter edits — replace the existing `pipeline_state: tagged` line with `pipeline_state: summarized` in both files.

---

## Step 9: Report Results

Summarize to the user:

```
Meeting summary complete for: [meeting note filename]

Sections written:
- Summary (X sentences)
- Key Decisions (X items)
- Action Items (X items, Y assigned to you)
- Discussion Notes (X topics)

Pipeline state → summarized
```
