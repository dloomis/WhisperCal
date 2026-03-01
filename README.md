# WhisperCal

Daily calendar view for Obsidian with Microsoft 365 integration. Create templated meeting notes with one click and link [MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) recordings and transcripts to your notes.

## Features

- **Calendar sidebar** — View today's meetings in a right-panel calendar view with day navigation
- **One-click meeting notes** — Create structured meeting notes from calendar events using customizable templates
- **Attendee matching** — Link attendees to People notes in your vault via `[[wiki links]]`
- **MacWhisper integration** — Link MacWhisper recordings to meeting notes and generate transcript files with speaker attribution
- **Unscheduled notes** — Create ad-hoc meeting notes that slot into the day's timeline

## Requirements

- **Obsidian** v1.4.10 or later (desktop only)
- **Microsoft 365 account** with an Azure AD app registration for calendar access
- **MacWhisper** (optional) — required only for recording/transcript features; must be installed at the default macOS location

### Azure AD setup

1. Register an application in the [Azure portal](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Set the platform to **Mobile and desktop applications** with redirect URI `https://login.microsoftonline.com/common/oauth2/nativeclient`
3. Grant the **Calendars.Read** delegated permission under Microsoft Graph
4. Copy the **Application (client) ID** and **Directory (tenant) ID** into the plugin settings

## Installation

### From community plugins

Search for **WhisperCal** in Obsidian's community plugin browser and click **Install**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/dloomis/whisper-cal/releases/latest)
2. Create a folder at `<vault>/.obsidian/plugins/whisper-cal/`
3. Copy the three files into that folder
4. Restart Obsidian and enable the plugin under **Settings > Community plugins**

## Configuration

Open **Settings > WhisperCal** to configure:

| Setting | Description |
|---------|-------------|
| Notes folder | Vault folder where meeting notes are created |
| People folder | Vault folder containing people notes for attendee matching |
| Transcripts folder | Vault folder for generated transcript files |
| Note filename template | Pattern for note filenames (`{{date}}`, `{{subject}}`) |
| Note template | Vault file used as a template for meeting note content |
| Timezone | IANA timezone for displaying meeting times |
| Refresh interval | How often the calendar view auto-refreshes |
| Tenant ID / Client ID | Azure AD app registration credentials |
| Cloud instance | Microsoft cloud environment (Public, USGov, USGovHigh, USGovDoD, China) |

## Disclosures

- **Remote services:** This plugin connects to the **Microsoft Graph API** to fetch calendar events. Authentication uses the OAuth 2.0 Device Code Flow. OAuth tokens are stored locally in the plugin's `data.json` file within your vault.
- **External file access:** The MacWhisper integration reads and writes to the MacWhisper SQLite database at `~/Library/Application Support/MacWhisper/Database/`. This is required to match recordings and extract transcripts. No data leaves your machine during this process.
- **Desktop only:** This plugin uses Node.js APIs (`child_process`, `os`) and is not available on Obsidian Mobile.

## License

[0-BSD](LICENSE)
