# Meeting Transcript Summarizer Prompt

Standalone prompt for summarizing a meeting transcript and writing the summary into the meeting note. Reads the meeting note to find the linked transcript, extracts content, generates a structured summary, and writes it back into the meeting note.

Executed by the WhisperCal plugin: this file is injected into the system prompt; the user message supplies `Meeting note: <path>.` and may supply `Additional instructions: <text>`.

You run headless in print mode: nobody sees intermediate output, and every token of narration between tool calls only slows the run. Work silently; the one-line report (Step 8) is the only text you print.

---

## Step 1: Parse Invocation Parameters

Extract from the calling message:
- `Meeting note:` → vault-relative path to the meeting note file
- `Additional instructions:` (optional) → user guidance for this run (emphasis, style, things to include or exclude). It takes precedence over the default guidelines below where they conflict.

**Vault root:** The current working directory is the vault root. All vault-relative paths in the calling message resolve from there.

**Path resolution:** Try the path as-is first. If not found, prepend vault root and try again. If still not found, error with: "Meeting note not found: [path]. Check the path and try again."

---

## Step 2: Read Inputs

Use the **Read tool** to open the meeting note, then resolve and read its linked transcript. All meeting metadata (subject, date, times, invitees, `is_recurring`) is already in the meeting note frontmatter — the LLM sees it directly when reading the file.

**Error conditions:**
- Meeting note does not exist → error as described in Step 1
- No `transcript` field in meeting note frontmatter → error: "Meeting note has no linked transcript. Link a recording first."

**Resolve transcript:** Strip `[[` and `]]` from the `transcript` link. If the result has no folder prefix, resolve it as `Transcripts/<name>.md`. If that file does not exist, glob for the basename across the vault before erroring.

**Read the full transcript:** Transcripts routinely exceed the Read tool's default length (TOME format is one short utterance per block, so a 25-50 minute meeting runs 2,500-4,300 lines), so pass a large `limit` (e.g. 10000) on the first Read to get the whole file in one call. If the output still ends before EOF, continue reading with `offset` until EOF. Never generate the summary from a partial transcript.

Collect everything in this single reading pass — microphone user, speaker roles, decisions, action items, discussion topics. Plan not to read the transcript again.

**Transcript frontmatter fields that matter:**

| Field | Notes |
|-------|-------|
| `attendees` | Speaker array: `name` (Speaker N or You), `proposed_name`, `confidence`, `evidence`. Ignore `stub`, `id`, and `line_count`. |
| `confirmed_speakers` | People note wikilinks, present after tagging. May contain duplicates; dedupe. |
| `pipeline_state` | Current transcript pipeline state |
| `meeting_note` | Backlink to the meeting note |

**Identify the microphone user:** the `attendees` entry whose `name` is `You` is the person who recorded the meeting. Pre-tagging, their utterances appear as `**You**` in the body; post-tagging, all body labels (including You) are real names, so use the You entry's `evidence` text (which typically names the person) to map it to a real name. If no You entry exists and no evidence mentions a microphone, say so in the final output and write the summary from a neutral perspective rather than guessing.

---

## Step 3: Pipeline State

The plugin verifies pipeline_state before invoking this prompt; do not re-check it and do not ask the user anything. If you nonetheless notice the state is unexpected, mention it in your final output and proceed.

---

## Step 4: Analyze Meeting Context

Before summarizing, gather context:

1. **Meeting type detection:** Determine from subject line and attendee count:
   - 1:1 meeting (2 attendees)
   - Small group (3-5 attendees)
   - Large meeting (6+ attendees)
   - Recurring meeting (check `is_recurring` in meeting note frontmatter)

2. **Speaker roles:** If `confirmed_speakers` links exist, read at most 4 People notes, preferring the most active speakers — issue all of these Read calls together in a single response, not one per turn. Skip this entirely for meetings with more than 8 attendees. If the calling message includes a `People Roster:` block, use it instead of reading any People notes.

3. **Microphone user perspective:** The summary should be written from the perspective of the microphone user — they are the note-taker. Identify what they said, what was directed at them, and what action items they were assigned.

---

## Step 5: Generate Summary

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
- [ ] Task for microphone user — [[Microphone User]] — YYYY-MM-DD

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
- **No important topics missing:** Verify every significant topic from the transcript is captured before finishing
- **Flag uncertainty:** If the transcript is unclear on a point, note it with [unclear] rather than guessing

### Action Item Rules

**Format:** `- [ ] Task — [[Owner]] / [[Requestor]] — YYYY-MM-DD — 🔺`
- If requestor same as owner, omit `/ [[Requestor]]`
- Fields separated by ` — ` (space-em-dash-space)
- Priority emoji at end (omit if standard priority)
- The ` — ` separators in the action item format are functional markers required by downstream processors; they are exempt from prose style rules. Summary and discussion prose follows the vault writing style (no em dashes as sentence punctuation).

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

---

## Step 6: Write Summary to Meeting Note

The generated block is exactly these four sections in order: `## Summary`, `## Key Decisions`, `## Action Items`, `## Key Discussion Points`.

- If the note already contains `## Summary`, replace everything from that heading through the end of the `## Key Discussion Points` section (up to the next `##` heading not in the generated set, or EOF) with the new block, in a single Edit.
- Otherwise insert the block after the frontmatter and any template/metadata content, before any user-written sections (such as `## Notes`).
- Never modify frontmatter or user-written content in either file.
- Do not re-read the note to verify the write — a failed Edit returns an error on its own; only when one fails, re-anchor with more context and retry.

---

## Step 7: Pipeline State

> **Do NOT edit `pipeline_state` in either file.** The WhisperCal plugin sets `pipeline_state: summarized` on both the meeting note and its linked transcript automatically after this prompt exits successfully. Do not modify frontmatter on the transcript at all; only edit the meeting note's body to insert the summary (Step 6).
>
> Historical note: this prompt used to instruct the LLM to find-and-replace `pipeline_state: tagged` → `pipeline_state: summarized`. Broad `old_string` values silently dropped adjacent frontmatter fields (notably `meeting_note`), which is why the plugin now owns this update.

---

## Step 8: Report Results

Print one line: `Summary written to <meeting note filename>: X decisions, Y action items (Z yours), W discussion topics.`
