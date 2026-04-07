# Meeting Transcript Summarizer Prompt

Standalone prompt for summarizing a meeting transcript and writing the summary into the meeting note. Reads the meeting note to find the linked transcript, extracts content, generates a structured summary, and writes it back into the meeting note.

**Invocation pattern:**
```
claude --dangerously-skip-permissions 'Follow the instructions in /abs/path/Meeting Transcript Summarizer Prompt.md. Meeting note: Meetings/2026-03-05 - Weekly Team Sync.md.'
```

---

## Step 1: Parse Invocation Parameters

Extract from the calling message:
- `Meeting note:` → vault-relative path to the meeting note file

**Vault root:** The current working directory is the vault root. All vault-relative paths in the calling message resolve from there.

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

[2-4 sentence executive summary of the meeting. Lead with the most important outcome or decision. Written in past tense. Use [[Name]] wikilinks for all people.]

## Key Decisions

- [Decision 1 — [[who]] decided, what was decided]
- [Decision 2]

## Action Items

- [ ] Task description — [[Owner]] / [[Requestor]] — YYYY-MM-DD — 🔺
- [ ] Task with same owner/requestor — [[Owner]] — YYYY-MM-DD
- [ ] Task for microphone user — [[Dan Loomis]] — YYYY-MM-DD

## Key Discussion Points

- **Topic Label** - Detailed explanation with [[Name]] references, specifics, and context
- **Topic Label** - Detailed explanation with [[Name]] references, specifics, and context
```

### Summary Guidelines

- **Be concise:** Each section should capture the essence, not transcribe the conversation
- **Attribute decisions:** Always note who made or approved a decision
- **Wikilink all names:** Wrap ALL person names in `[[Name]]` in Summary, Key Decisions, Action Items, and Key Discussion Points
- **Action item format:** `- [ ] Task — [[Owner]] / [[Requestor]] — YYYY-MM-DD — 🔺` (see Action Item Rules below)
- **Discussion points format:** Each bullet starts with a **bold topic label** (2-5 words), then a dash, then detailed explanation with `[[Name]]` references, specific details, and context
- **Skip small talk:** Don't include greetings, weather chat, or off-topic banter
- **Preserve technical details:** Keep specific numbers, dates, names, and technical terms accurate
- **Flag uncertainty:** If the transcript is unclear on a point, note it with [unclear] rather than guessing

### Action Item Rules

**Format:** `- [ ] Task — [[Owner]] / [[Requestor]] — YYYY-MM-DD — 🔺`
- If requestor same as owner, omit `/ [[Requestor]]`
- Fields separated by ` — ` (space-em-dash-space)
- Priority emoji at end (omit if standard priority)

**Due Dates:**
- Default: Meeting Date + 7 calendar days
- "tomorrow" → Meeting Date + 1
- "next week" → Meeting Date + 7
- "end of week" → Next Friday from Meeting Date
- "ASAP" / "urgent" → Meeting Date + 2

**Priority:**
- ⏫ High: Blocking others, executive request, time-sensitive, security/compliance
- 🔼 Medium: Important but flexible
- (omit): Standard work, no urgency
- 🔽 Low: Nice-to-have, backlog

**Meeting Ownership (determines quantity):**
- Microphone user IS facilitator → capture ALL action items
- Microphone user is NOT facilitator → ALL microphone user items + up to 5-7 important others
- Default to "not facilitator" when unclear

### Quality Checklist

Before writing the summary, verify:
- [ ] ALL person names wrapped in `[[Name]]` wikilinks
- [ ] Every action item uses `— [[Owner]] — YYYY-MM-DD` format with due date
- [ ] Every Key Discussion Point starts with a **bold topic label**
- [ ] Key decisions are captured with context
- [ ] No important topics from the transcript are missing
- [ ] Meeting ownership correctly determined for action item quantity

---

## Step 7: Write Summary to Meeting Note

Use the **Edit tool** to insert the summary into the meeting note.

**Placement:** Insert the summary content after the frontmatter closing `---` and any existing template content (like attendee lists or meeting metadata). If the note already has a `## Summary` section, replace it entirely.

**Preserve existing content:** The meeting note may contain hand-written notes (e.g. a `## Notes` section), Teams dial-in blocks, or other user-added content. Any content that is NOT part of the generated summary sections (`## Summary`, `## Key Decisions`, `## Action Items`, `## Key Discussion Points`) must be preserved. Place the generated summary sections between the header/template content and any existing user content.

**Strategy:**
1. Read the current meeting note content
2. Identify any user-written content (sections other than Summary/Key Decisions/Action Items/Key Discussion Points, such as `## Notes`, meeting links, etc.)
3. Find the insertion point (after frontmatter and any header/metadata sections)
4. If a `## Summary` section already exists, replace only the generated sections (Summary through Key Discussion Points), preserving everything before and after
5. If no summary exists, insert the generated sections after the last frontmatter/template content and before any user-written sections
6. Use a single Edit call to write the summary

---

## Step 8: Update Pipeline State

> **CRITICAL — DO NOT SKIP THIS STEP.** The plugin UI relies on `pipeline_state: summarized` to mark the Summary pill as complete. If you do not update both files, the user will see an incomplete workflow and have to fix it manually. This step is mandatory even if the summary was short or the meeting was trivial.

After successfully writing the summary, you MUST update **both** files:

1. **Meeting note:** Replace `pipeline_state: tagged` with `pipeline_state: summarized` in the frontmatter
2. **Transcript:** Replace `pipeline_state: tagged` with `pipeline_state: summarized` in the frontmatter

**Edit strategy:** Use the Edit tool to make a targeted find-and-replace of the `pipeline_state: tagged` line in each file's YAML frontmatter. Do this as two separate Edit calls — one for the meeting note, one for the transcript. Do NOT proceed to Step 9 until both edits are confirmed successful.

**Verification:** After editing, re-read the frontmatter of both files and confirm `pipeline_state: summarized` is present. If either edit failed, retry before continuing.

---

## Step 9: Report Results

Summarize to the user:

```
Meeting summary complete for: [meeting note filename]

Sections written:
- Summary (X sentences)
- Key Decisions (X items)
- Action Items (X items, Y assigned to you)
- Key Discussion Points (X topics)

Pipeline state → summarized
```
