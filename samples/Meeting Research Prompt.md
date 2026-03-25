# Meeting Research Prompt

Standalone prompt for pre-meeting research. Reads selected vault notes (People profiles, prior meeting notes, project docs) and the meeting note, then writes a structured research briefing into the meeting note so the user is prepared before the meeting starts.

**Invocation pattern:**
```
claude --dangerously-skip-permissions 'Follow the instructions in /abs/path/Meeting Research Prompt.md. Meeting note: Meetings/2026-03-25 - Weekly Team Sync.md. Research notes: People/Alice Smith.md, Meetings/2026-03-18 - Weekly Team Sync.md, Projects/Alpha.md.'
```

**Optional parameters:**
- `People Folder:` — folder name for People notes (default: `People`)
- `Additional instructions:` — free-text user instructions appended to the invocation

---

## Step 1: Parse Invocation Parameters

Extract from the calling message:
- `Meeting note:` → vault-relative path to the meeting note file
- `Research notes:` → comma-separated list of vault-relative paths to context notes
- `People Folder:` → folder for People notes (optional)
- `Additional instructions:` → free-text guidance from the user (optional)

**Vault root:** Determine from the absolute path of this prompt file by stripping the filename and any `Prompts/` suffix. For example, if the prompt is at `/vault/Prompts/Meeting Research Prompt.md`, the vault root is `/vault`.

**Path resolution:** Try each path as-is first. If not found, prepend vault root and try again. If a research note is not found, skip it with a warning rather than failing — the user may have renamed or moved it.

---

## Step 2: Read Meeting Note

Use the **Read tool** to open the meeting note. Extract from frontmatter:

| Field | Purpose |
|-------|---------|
| `meeting_subject` | Meeting title for context |
| `meeting_date` | Meeting date |
| `meeting_start` | Start time |
| `meeting_end` | End time |
| `meeting_invitees` | Attendee list (wikilinks) |
| `is_recurring` | Whether this is a recurring meeting |

**Error conditions:**
- File does not exist → error: "Meeting note not found: [path]. Check the path and try again."

---

## Step 3: Read Research Notes

Use the **Read tool** to open each research note. For each note, capture:

1. **Frontmatter metadata** — any structured data (role, title, email, dates, etc.)
2. **Body content** — the full note content

Categorize each note by type:
- **Person note** — has frontmatter with name/role/email fields, or is in the People folder
- **Meeting note** — has `meeting_subject` and `meeting_date` in frontmatter
- **Project/other note** — everything else

---

## Step 4: Gather Additional Context

If a `People Folder` was provided, cross-reference meeting invitees with People notes:

1. Parse `meeting_invitees` wikilinks from the meeting note
2. For any invitee whose People note was NOT already included in the research notes, do a quick read of their note (if it exists) to get their role/title
3. This provides baseline context on all attendees without requiring the user to manually select every person

---

## Step 5: Follow Additional Instructions

If `Additional instructions` were provided, incorporate them into the research. These may include:
- Specific questions to answer about attendees or topics
- Directions to focus on particular aspects (e.g., "focus on project status updates from the last month")
- Requests to cross-reference with other vault content
- Context about why this research is needed

Treat additional instructions as high-priority guidance that shapes the research output.

---

## Step 6: Generate Research Briefing

Create a structured research briefing with these sections:

### Briefing Structure

```markdown
## Research

### Attendees

| Name | Role | Context |
|------|------|---------|
| [[Name]] | Title / Team | Key context from People note or prior meetings |

### Background

[2-4 paragraphs synthesizing relevant context from the research notes. Connect the dots between attendees, prior meetings, and project context. Focus on what the user needs to know going into this meeting.]

### Prior Meeting Outcomes

- **YYYY-MM-DD — Meeting Subject** — Key outcomes, open action items, unresolved topics
- [One bullet per prior meeting note provided]

### Open Questions

- [Questions the user might want to raise based on the research]
- [Unresolved items from prior meetings]
- [Gaps in context that could be clarified in this meeting]
```

### Briefing Guidelines

- **Be actionable:** Focus on information that helps the user prepare, not exhaustive summaries
- **Wikilink all names:** Wrap ALL person names in `[[Name]]` wikilinks
- **Connect the dots:** Don't just summarize each note in isolation — identify relationships, continuity from prior meetings, and evolving topics
- **Highlight changes:** If a person's role or a project's status has changed since the last meeting, call it out
- **Respect the user's time:** Keep it scannable. Use tables for structured data, bullets for lists, and bold for emphasis
- **Omit empty sections:** If there are no prior meetings to reference, skip "Prior Meeting Outcomes". If the attendee list is trivial (1:1 with someone well-known), keep the table minimal
- **Additional instructions first:** If the user provided specific instructions, make sure those are addressed prominently in the briefing

### Quality Checklist

Before writing the briefing, verify:
- [ ] ALL person names wrapped in `[[Name]]` wikilinks
- [ ] Attendee table includes all meeting invitees (not just those in research notes)
- [ ] Prior meeting outcomes include any open action items still relevant
- [ ] Additional user instructions have been addressed
- [ ] No important context from the research notes is missing

---

## Step 7: Write Research to Meeting Note

Use the **Edit tool** to insert the research briefing into the meeting note.

**Placement:** Insert the `## Research` section after the frontmatter closing `---` and any existing template content (like attendee lists or meeting links). Place it BEFORE any `## Notes`, `## Summary`, or other user/LLM-generated sections.

**If a `## Research` section already exists:** Replace it entirely with the new briefing. Preserve all other sections.

**Strategy:**
1. Read the current meeting note content
2. Identify the insertion point (after frontmatter/template header, before other content sections)
3. If `## Research` already exists, replace only that section
4. If it doesn't exist, insert the new section at the appropriate location
5. Use a single Edit call to write the briefing

---

## Step 8: Update Frontmatter

After successfully writing the research briefing, update the meeting note frontmatter:

The `research_notes` field should already be set by the plugin (listing the selected notes as wikilinks). No additional frontmatter changes are needed.

---

## Step 9: Report Results

Summarize to the user:

```
Meeting research complete for: [meeting note filename]

Research sources:
- [N] vault notes analyzed
- [N] attendees profiled

Sections written:
- Attendees ([N] people)
- Background ([N] paragraphs)
- Prior Meeting Outcomes ([N] meetings referenced)
- Open Questions ([N] items)
```
