# WhisperCal

A desktop-only Obsidian plugin that puts your Microsoft 365 calendar in a sidebar, creates templated meeting notes with one click, links [MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) recordings and transcripts to those notes, and drives an LLM-powered pipeline to tag speakers and summarize meetings.

> **Desktop only.** WhisperCal uses Node APIs and AppleScript and will not load on Obsidian mobile.

---

## Table of Contents

- [Features at a Glance](#features-at-a-glance)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Setup](#setup)
  - [Azure AD App Registration](#azure-ad-app-registration)
  - [Signing In](#signing-in)
  - [Cloud Instances](#cloud-instances)
- [The Calendar View](#the-calendar-view)
  - [Navigation](#navigation)
  - [Status Indicator](#status-indicator)
  - [Meeting Cards](#meeting-cards)
  - [Unscheduled Meetings](#unscheduled-meetings)
  - [Active Event Highlighting](#active-event-highlighting)
  - [Note-Open Highlighting](#note-open-highlighting)
- [The Four-Stage Pipeline](#the-four-stage-pipeline)
  - [Stage 1 — Note](#stage-1--note)
  - [Stage 2 — Transcript](#stage-2--transcript)
  - [Stage 3 — Speakers](#stage-3--speakers)
  - [Stage 4 — Summary](#stage-4--summary)
  - [Pipeline State Tracking](#pipeline-state-tracking)
- [Meeting Note Templates](#meeting-note-templates)
  - [Default Template](#default-template)
  - [Custom Templates](#custom-templates)
  - [Template Variables](#template-variables)
  - [Reserved Frontmatter Keys](#reserved-frontmatter-keys)
- [MacWhisper Integration](#macwhisper-integration)
  - [How Recording Matching Works](#how-recording-matching-works)
  - [Transcript File Format](#transcript-file-format)
  - [Linking Flow in Detail](#linking-flow-in-detail)
- [People Matching](#people-matching)
- [LLM Integration](#llm-integration)
  - [Speaker Tagging](#speaker-tagging)
  - [Summarization](#summarization)
  - [LLM Settings](#llm-settings)
- [Calendar Caching](#calendar-caching)
- [Commands](#commands)
- [Settings Reference](#settings-reference)
- [Disclosures](#disclosures)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Features at a Glance

- **Calendar sidebar** — Browse your Outlook calendar day by day inside Obsidian, with automatic refresh and offline caching.
- **One-click meeting notes** — Create a pre-filled note from any calendar event using a customizable template with wiki-linked attendees.
- **MacWhisper recording linking** — Match MacWhisper recordings to meetings by timestamp, link them to the note, and auto-generate a transcript file.
- **Speaker tagging** — Send the transcript to an LLM (via Claude Code) to identify and label speakers.
- **Meeting summarization** — Send the tagged transcript to an LLM to produce an executive summary.
- **People matching** — Attendees are automatically matched to notes in a People folder and rendered as `[[wiki links]]`.

---

## Prerequisites

- **Obsidian** 1.4.10 or later (desktop only)
- A **Microsoft 365** account with calendar access
- An **Azure AD app registration** (see [Setup](#azure-ad-app-registration))
- **MacWhisper** (optional — needed for transcript features)
- **Claude Code** CLI or another LLM CLI tool (optional — needed for speaker tagging and summarization)

---

## Installation

### From Community Plugins (when published)

1. Open **Settings > Community plugins > Browse**.
2. Search for "WhisperCal".
3. Click **Install**, then **Enable**.

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/dloomis/whisper-cal/releases/latest).
2. Create a folder at `<your-vault>/.obsidian/plugins/whisper-cal/`.
3. Copy the three files into that folder.
4. Open **Settings > Community plugins** and enable **WhisperCal**.

---

## Setup

### Azure AD App Registration

WhisperCal connects to your calendar through the Microsoft Graph API. You need to register an app in Azure AD:

1. Go to the [Azure Portal](https://portal.azure.com) > **Azure Active Directory** > **App registrations** > **New registration**.
2. Set a name (e.g., "WhisperCal").
3. Under **Supported account types**, choose the option that matches your organization.
4. Under **Redirect URI**, select **Public client/native** and leave the URI blank (the Device Code flow does not use redirects).
5. Click **Register**.
6. On the app's **Overview** page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
7. Go to **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**.
8. Add **Calendars.Read** and **offline_access**.
9. Click **Grant admin consent** (if required by your organization).

Then in WhisperCal settings:
- Paste the **Tenant ID** and **Client ID** into the corresponding fields.
- Select your **Cloud instance** (most users should leave this on "Public").

### Signing In

WhisperCal uses the **Device Code Flow** — a two-step process designed for apps that can't open a browser popup:

1. Click **Sign in with Microsoft** in the WhisperCal settings panel.
2. A **user code** appears (e.g., `ABC12DEF`) along with a link to the Microsoft device login page.
3. Open the link in your browser, enter the code, and sign in with your Microsoft account.
4. Once you complete sign-in in the browser, WhisperCal detects it automatically and shows "Signed in".

Your tokens are stored locally in the plugin's `data.json` file within your vault. Access tokens refresh automatically; you should rarely need to sign in again.

To sign out, click **Sign out** in settings.

### Cloud Instances

If your organization uses a government or sovereign cloud, select the appropriate instance in settings:

| Instance | Authority | Graph API | Who uses it |
|----------|-----------|-----------|-------------|
| **Public** | `login.microsoftonline.com` | `graph.microsoft.com` | Most organizations |
| **USGov** | `login.microsoftonline.com` | `graph.microsoft.com` | US Government (GCC) |
| **USGovHigh** | `login.microsoftonline.us` | `graph.microsoft.us` | US Government (GCC High) |
| **USGovDoD** | `login.microsoftonline.us` | `dod-graph.microsoft.us` | US Department of Defense |
| **China** | `login.chinacloudapi.cn` | `microsoftgraph.chinacloudapi.cn` | 21Vianet (China) |

You can also override the **Device login URL** if your environment uses a non-standard endpoint.

---

## The Calendar View

Open the calendar sidebar by clicking the **calendar ribbon icon** or running the **"Open calendar view"** command.

### Navigation

- **Left / right chevron** — Move one day backward or forward.
- **Today button** — Jump to the current date (hidden when already viewing today).
- **Refresh button** — Manually refresh calendar data from Microsoft 365.

The calendar auto-refreshes on a configurable interval (default: every 5 minutes). At midnight, the view automatically advances to the new day.

### Status Indicator

A small dot below the header shows connection status:

- **Green dot** + "Updated X min ago" — Live data from Microsoft 365.
- **Gray dot** + "Cached X min ago" — Showing previously fetched data (offline or between refreshes).
- **Gray dot** + "Offline" — No cached data available for this day.

### Meeting Cards

Each calendar event is displayed as a card showing:

- **Subject** — The meeting title.
- **Time** — Start and end times, "All day", or "Ad hoc" for unscheduled meetings.
- **Location** — If the event has an online meeting URL (Teams, Zoom, etc.), clicking the location opens it.
- **Attendee count** — Number of invitees.
- **Four workflow pills** — Note, Transcript, Speakers, Summary (see [The Four-Stage Pipeline](#the-four-stage-pipeline)).

Cards are grouped into sections: **All day** events at the top, then **Scheduled** (or **Today**) events sorted by start time.

### Unscheduled Meetings

An "Unscheduled Meeting" card always appears at the top of the calendar view. Use it to create notes for ad-hoc meetings that aren't on your calendar. The subject is configurable in settings (default: "Unscheduled Meeting").

Unscheduled notes use the current timestamp as their meeting time and get a wider recording-matching window (720 minutes instead of the usual 10).

### Active Event Highlighting

When viewing today's calendar:
- **Currently ongoing events** (between start and end time) are highlighted.
- If no event is ongoing, the **next upcoming event** is highlighted instead.

### Note-Open Highlighting

When you open a meeting note in any editor tab, the corresponding card in the calendar sidebar is highlighted and scrolled into view. If the note belongs to a different day, the calendar automatically navigates to that day.

---

## The Four-Stage Pipeline

Each meeting card has four **pill buttons** that track your progress through the meeting workflow. Pills are filled with a checkmark when complete, outlined when ready to act on, and grayed out when their prerequisites aren't met.

```
Note  -->  Transcript  -->  Speakers  -->  Summary
```

### Stage 1 — Note

**Click the "Note" pill** to create a meeting note from the calendar event.

- A new Markdown file is created in your configured notes folder using your template.
- The filename follows your configured pattern (default: `YYYY-MM-DD - Subject.md`).
- Frontmatter is populated with meeting metadata (subject, date, time, location, attendees, etc.).
- Attendees are matched against your People folder and rendered as `[[wiki links]]`.
- The note opens in a new tab with the cursor placed after the `# Notes` heading.

Once the note exists, clicking the pill opens it.

### Stage 2 — Transcript

**Click the "Transcript" pill** to link a MacWhisper recording and generate a transcript file.

- A picker modal shows MacWhisper recordings that started near the meeting time.
- Select a recording, and WhisperCal:
  1. Writes the MacWhisper session ID into the note's frontmatter.
  2. Sets the recording's title in MacWhisper to match the note name.
  3. Waits for MacWhisper to finish transcribing (polls every 3 seconds, up to ~3 minutes).
  4. Creates a transcript Markdown file in your configured transcripts folder.
  5. Links the transcript back to the meeting note via frontmatter.

Once the transcript exists, clicking the pill opens it.

### Stage 3 — Speakers

**Click the "Speakers" pill** to launch an LLM session that identifies and labels speakers in the transcript.

- Opens a Terminal (or iTerm2) window running your configured LLM CLI (default: `claude`).
- The LLM reads your speaker tagging prompt file and the transcript, then tags each speaker.
- When finished, the LLM sets `pipeline_state: tagged` in the transcript frontmatter.

Once speakers are tagged, clicking the pill opens the transcript.

### Stage 4 — Summary

**Click the "Summary" pill** to launch an LLM session that summarizes the meeting.

- Opens a Terminal (or iTerm2) window running your configured LLM CLI.
- The LLM reads your summarizer prompt file along with the meeting note and transcript.
- When finished, the LLM sets `pipeline_state: summarized`.

Once the summary is complete, clicking the pill opens the meeting note.

### Pipeline State Tracking

Pipeline state is stored in frontmatter as `pipeline_state` with these values:

| Value | Meaning |
|-------|---------|
| `titled` | Transcript created, ready for speaker tagging |
| `tagged` | Speakers identified, ready for summarization |
| `summarized` | Summary complete, pipeline finished |

The state lives on the **transcript file** as its source of truth. WhisperCal automatically **mirrors** it to the meeting note's frontmatter whenever the transcript changes, so both files stay in sync.

---

## Meeting Note Templates

### Default Template

WhisperCal ships with a built-in template that creates notes with full meeting metadata in frontmatter and the event description in the body. You can preview it by clicking **"Create default template"** in settings, which writes it to a file in your vault.

### Custom Templates

To customize your meeting notes:

1. Click **"Create default template"** in settings to export the built-in template to a file (default path: `Templates/WhisperCal Meeting.md`).
2. Edit the file to your liking.
3. Set the **"Note template"** setting to point to your modified file.

If the template file is missing or unreadable, WhisperCal falls back to the built-in default and shows a notice.

### Template Variables

Use `{{variableName}}` placeholders in your template. All available variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{eventId}}` | Calendar event ID | `AAMkAG...` |
| `{{subject}}` | Meeting subject | `Weekly Standup` |
| `{{date}}` | Meeting date | `2026-03-07` |
| `{{startTime}}` | Start time | `10:00 AM` |
| `{{endTime}}` | End time | `10:30 AM` |
| `{{location}}` | Location or "N/A" | `Conference Room B` |
| `{{organizer}}` | Organizer as wiki link (if matched) or plain name | `[[Jane Smith]]` |
| `{{organizerName}}` | Organizer display name | `Jane Smith` |
| `{{organizerEmail}}` | Organizer email address | `jane@example.com` |
| `{{attendeeCount}}` | Number of attendees | `5` |
| `{{attendees}}` | Comma-separated wiki links | `"[[Jane Smith]]", "[[Bob Lee]]"` |
| `{{attendeeList}}` | Bullet list of wiki links | `- [[Jane Smith]]` (one per line) |
| `{{invitees}}` | YAML-formatted list (for frontmatter) | `  - "Jane Smith"` |
| `{{isOnlineMeeting}}` | Whether it has an online link | `true` |
| `{{onlineMeetingUrl}}` | Teams/Zoom join URL | `https://teams.microsoft.com/...` |
| `{{isAllDay}}` | All-day event flag | `false` |
| `{{isRecurring}}` | Recurring event flag | `true` |
| `{{description}}` | Event body (HTML converted to Markdown) | Meeting agenda text |
| `{{noteCreated}}` | ISO 8601 timestamp of note creation | `2026-03-07T09:55:00-05:00` |

### Reserved Frontmatter Keys

The following keys are read and written by the plugin. **Do not rename or remove them**, or plugin features will break:

| Key | Purpose |
|-----|---------|
| `calendar_event_id` | Identifies this file as a WhisperCal meeting note |
| `macwhisper_session_id` | Links a MacWhisper recording to the note |
| `meeting_date` | Calendar navigation and recording time matching |
| `meeting_start` | Recording time matching |
| `meeting_subject` | Display title in the calendar view; passed to transcript |
| `note_created` | Fallback timestamp for unscheduled notes |
| `is_recurring` | Passed to transcript creation |
| `invitees` | Attendee list; passed to transcript creation |
| `transcript` | Backlink to the transcript file |
| `pipeline_state` | Workflow state; mirrored from transcript automatically |
| `tags` | Used to distinguish meeting notes from transcript files |

These keys are **informational only** (not read by the plugin) and safe to customize or remove:

| Key | Purpose |
|-----|---------|
| `meeting_end` | Meeting end time |
| `meeting_location` | Meeting location |
| `organizer` | Meeting organizer |

---

## MacWhisper Integration

WhisperCal reads directly from MacWhisper's local SQLite database to match recordings to meetings and extract transcripts. It does not modify your audio files.

**Requirements:**
- MacWhisper must be installed (database path: `~/Library/Application Support/MacWhisper/Database/main.sqlite`).
- Recordings must be transcribed in MacWhisper before a transcript file can be created. WhisperCal will wait up to ~3 minutes for transcription to complete.

A **microphone ribbon icon** is provided to quickly launch MacWhisper.

### How Recording Matching Works

When you click the Transcript pill, WhisperCal queries the MacWhisper database for sessions whose recording start time falls within a configurable window of the meeting's scheduled start time.

- **Default window:** 10 minutes before or after the meeting start.
- **Unscheduled meetings:** 720-minute window (12 hours).
- **Recording start time** is determined from the filesystem birthtime of the track-0 audio file, which is more accurate than MacWhisper's database timestamps.

If multiple recordings match, a picker modal lets you choose. The picker shows the recording title, date, time, and duration for each match.

### Transcript File Format

Transcript files are created in your configured transcripts folder with the naming pattern `<Note Name> - Transcript.md`. They contain:

**Frontmatter:**
- `date` — Recording date with timezone offset
- `tags: [transcript]` — Identifies the file as a transcript
- `macwhisper_session_id` — Links back to the MacWhisper session
- `duration` — Recording length in seconds
- `meeting_note` — Wiki link back to the meeting note
- `speaker_count` — Number of detected speakers
- `speakers` — List of speaker names, IDs, and line counts
- `meeting_subject`, `is_recurring`, `invitees` — Copied from the meeting note so the transcript is self-contained (these are read by LLM prompts)
- `pipeline_state: titled` — Initial pipeline state

**Body:**
- **AI Summary** section (if MacWhisper generated one) — Displayed as a blockquote.
- **Full Transcript** section:
  - **Diarized recordings** (speakers identified): Grouped by speaker with timestamps:
    ```
    **Jane Smith** [00:01:23]
    Let's start with the status update from last week...
    ```
  - **Non-diarized recordings**: Timestamped lines without speaker labels:
    ```
    [00:01:23] Let's start with the status update from last week...
    ```

### Linking Flow in Detail

1. **Match** — Query MacWhisper DB for recordings near the meeting time.
2. **Select** — If multiple matches, pick one from the modal.
3. **Title** — Set the recording's title in MacWhisper to match the note name.
4. **Link** — Write `macwhisper_session_id` to the meeting note's frontmatter.
5. **Wait** — Poll for transcription completion (every 3s, up to ~3 min).
6. **Transcribe** — Create the transcript Markdown file with full text and metadata.
7. **Backlink** — Write `transcript: [[path/to/transcript]]` to the meeting note.

If MacWhisper hasn't finished transcribing within the timeout, you'll see a notice suggesting you try linking again later. The session ID is already saved, so re-linking will skip to step 5.

---

## People Matching

WhisperCal can match meeting attendees to notes in a **People folder** in your vault, rendering them as `[[wiki links]]` in meeting notes and providing context for LLM prompts.

### Setup

1. Create a folder in your vault for people notes (e.g., `People/`).
2. Set the **"People folder"** path in WhisperCal settings.
3. Each person note should have frontmatter with identifying information.

### Matching Fields

WhisperCal matches attendees by checking these frontmatter fields in People notes:

**Email fields** (matched against the attendee's email address, case-insensitive):
- `company_email`
- `personal_email`
- `sipr_email`
- `nipr_email`
- `preferred_email`

**Name field** (matched against the attendee's display name, case-insensitive):
- `full_name`

Email matching is tried first; if no email match is found, name matching is attempted. Matched attendees appear as `[[Note Name]]` wiki links in the template output. Unmatched attendees appear as plain text names.

### Example People Note

```markdown
---
full_name: Jane Smith
company_email: jane.smith@example.com
---

# Jane Smith

Role: Engineering Manager
```

---

## LLM Integration

WhisperCal can invoke an external LLM CLI tool to tag speakers in transcripts and summarize meetings. It launches a terminal window where the LLM runs interactively.

### Speaker Tagging

**Prerequisite:** A transcript file must exist (Stage 2 complete).

1. Create a prompt file in your vault (e.g., `Prompts/Speaker Tagging.md`) that instructs the LLM how to identify speakers.
2. Set the **"Speaker tagging prompt"** path in settings.
3. Click the **Speakers pill** on a meeting card, or run the **"Tag speakers in transcript"** command.
4. A terminal window opens with the LLM reading your prompt and the transcript file.
5. The LLM identifies speakers and updates the transcript.
6. When done, the LLM writes `pipeline_state: tagged` to the transcript frontmatter.

### Summarization

**Prerequisite:** Speakers must be tagged (Stage 3 complete, `pipeline_state: tagged`).

1. Create a prompt file (e.g., `Prompts/Meeting Summarizer.md`).
2. Set the **"Summarizer prompt"** path in settings.
3. Click the **Summary pill** on a meeting card, or run the **"Summarize meeting transcript"** command.
4. A terminal window opens with the LLM reading your prompt, the meeting note, and the transcript.
5. The LLM generates a summary and writes `pipeline_state: summarized`.

### LLM Settings

| Setting | Default | Description |
|---------|---------|-------------|
| **CLI command** | `claude` | The command to invoke the LLM. Change this if you use a different CLI tool. |
| **Skip permissions** | On | Passes `--dangerously-skip-permissions` so the LLM can read/write files without per-operation prompts. Safe for trusted prompts. |
| **Additional flags** | (empty) | Extra CLI flags appended to every LLM invocation. |
| **Terminal app** | Terminal | Which macOS terminal to open: **Terminal** or **iTerm2**. |
| **Microphone user** | (empty) | Your full name as it appears in meetings. Passed to the LLM to help identify your voice in recordings. |

### How Invocation Works

WhisperCal builds a shell command, writes it to a temporary script, and uses AppleScript to execute it in a new terminal window. The command changes directory to your vault root and runs the LLM CLI with:

- The path to your prompt file
- The path to the target file (transcript or meeting note)
- Context parameters: your name, transcript folder, and People folder path

---

## Calendar Caching

WhisperCal maintains a local cache of calendar data so you can browse your schedule offline.

**Behavior:**
- **Past days** are served from cache and never re-fetched (they won't change).
- **Today and future days** are fetched live when possible, with cache as a fallback if offline.
- **Pre-fetching** — After a successful fetch of today's events, the next N days are pre-fetched in the background (configurable, default: 5 days).
- **Retention** — Cached days older than the retention period are pruned automatically (configurable, default: 30 days).

---

## Commands

All commands are available from the command palette (`Cmd+P`):

| Command | Description |
|---------|-------------|
| **Open calendar view** | Opens the WhisperCal calendar sidebar |
| **Link MacWhisper recording** | Links a MacWhisper recording to the active meeting note (only available when a meeting note is open) |
| **Tag speakers in transcript** | Launches LLM speaker tagging for the active note's transcript (available on meeting notes with a transcript, or directly on transcript files) |
| **Summarize meeting transcript** | Launches LLM summarization (available when `pipeline_state` is `tagged`) |

**Link MacWhisper recording** is also available in the file context menu (right-click) for meeting notes.

**Ribbon icons:**
- **Calendar icon** — Opens the calendar view.
- **Microphone icon** — Launches the MacWhisper app.

---

## Settings Reference

### Notes

| Setting | Default | Description |
|---------|---------|-------------|
| **People folder** | *(empty)* | Vault folder containing people notes. Matched attendees render as `[[wiki links]]`. |
| **Notes folder** | `Meetings` | Where meeting notes are created. |
| **Transcripts folder** | `Transcripts` | Where transcript files are created. |
| **Note filename template** | `{{date}} - {{subject}}` | Filename pattern. Available variables: `{{date}}`, `{{subject}}`. |
| **Unscheduled note subject** | `Unscheduled Meeting` | Subject line for ad-hoc meeting notes. |
| **Note template** | *(empty = built-in)* | Path to a custom template file. Leave empty to use the default. |

### MacWhisper

| Setting | Default | Description |
|---------|---------|-------------|
| **Database path** | *(read-only)* | Shows the MacWhisper database location. |
| **Recording match window** | `10` min | How close a recording start must be to the meeting time to appear in the picker. |

### LLM

| Setting | Default | Description |
|---------|---------|-------------|
| **Speaker tagging prompt** | *(empty)* | Path to your speaker tagging prompt file. |
| **Summarizer prompt** | *(empty)* | Path to your summarization prompt file. |
| **Microphone user** | *(empty)* | Your full name, passed to the LLM to identify your voice. |
| **CLI command** | `claude` | LLM CLI executable name. |
| **Skip permissions** | On | Allow the LLM to read/write files without prompting. |
| **Additional flags** | *(empty)* | Extra CLI flags for the LLM command. |
| **Terminal app** | Terminal | Terminal application to open (Terminal or iTerm2). |

### Calendar

| Setting | Default | Description |
|---------|---------|-------------|
| **Timezone** | `America/New_York` | IANA timezone for displaying meeting times. |
| **Refresh interval** | `5` min | Auto-refresh frequency for the calendar view. |
| **Cache future days** | `5` | Number of upcoming days to pre-fetch. |
| **Cache retention** | `30` days | How long past calendar data is kept locally. |

### Microsoft Account

| Setting | Default | Description |
|---------|---------|-------------|
| **Tenant ID** | *(empty)* | Directory (tenant) ID from your Azure AD app registration. |
| **Client ID** | *(empty)* | Application (client) ID from your Azure AD app registration. |
| **Cloud instance** | Public | Microsoft cloud environment. |
| **Device login URL** | *(empty = auto)* | Override the device code login URL for non-standard environments. |

---

## Disclosures

- **Remote services:** This plugin connects to the **Microsoft Graph API** to fetch calendar events. Authentication uses the OAuth 2.0 Device Code Flow. OAuth tokens are stored locally in the plugin's `data.json` file within your vault.
- **External file access:** The MacWhisper integration reads and writes to the MacWhisper SQLite database at `~/Library/Application Support/MacWhisper/Database/`. This is required to match recordings and extract transcripts. No data leaves your machine during this process.
- **LLM invocation:** When you use the speaker tagging or summarization features, WhisperCal launches an external CLI tool (default: `claude`) in a terminal window. Your transcript and meeting note content are passed to that tool. Review your LLM provider's privacy policy to understand how your data is handled.
- **Desktop only:** This plugin uses Node.js APIs (`child_process`, `os`) and AppleScript, and is not available on Obsidian Mobile.

---

## Troubleshooting

### "Tenant ID and Client ID are required"
Both fields must be filled in before you can sign in. See [Azure AD App Registration](#azure-ad-app-registration).

### Device code expired
The device code is valid for about 15 minutes. If it expires before you complete sign-in in the browser, click **"Try again"** in settings to get a new code.

### Calendar shows "Offline" with no events
- Check that you're signed in (Settings > WhisperCal > Microsoft Account section should show "Signed in").
- Try clicking the refresh button in the calendar header.
- Verify your Azure AD app has the **Calendars.Read** permission.

### No MacWhisper recordings found
- Ensure MacWhisper is installed and has recordings in its database.
- Check that the recording happened within the match window (default: 10 minutes of the meeting start time). You can increase this in settings.
- MacWhisper must have completed transcription before a transcript file can be created.

### LLM terminal doesn't open
- Verify the **CLI command** setting matches an installed CLI tool (e.g., `claude`).
- Ensure your **Speaker tagging prompt** or **Summarizer prompt** path points to an existing file.
- If using iTerm2, make sure it's installed and set as the terminal app in settings.

### Pipeline pills are grayed out
Pills are disabled when their prerequisites aren't met:
- **Transcript** requires a meeting note to exist first.
- **Speakers** requires a linked transcript.
- **Summary** requires speakers to be tagged (`pipeline_state: tagged`).

### Meeting note attendees aren't wiki-linked
- Set the **People folder** path in settings.
- Ensure people notes have a `full_name` or email field in frontmatter that matches the attendee's Microsoft 365 display name or email address.

---

## License

[0-BSD](LICENSE)
