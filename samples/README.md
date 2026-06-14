# Sample Files

This folder contains sample prompt and template files for WhisperCal.

| File | Purpose |
|------|---------|
| `Transcript Post-Processing Prompt.md` | Claude Code prompt that fixes transcription + diarization errors in a transcript and proposes speaker identities (the default speaker step) |
| `Speaker Auto-Tag Prompt.md` | Legacy speaker-tagging prompt — superseded by Transcript Post-Processing, kept for reference |
| `Meeting Transcript Summarizer Prompt.md` | Claude Code prompt for summarizing a meeting transcript into the meeting note |
| `WhisperCal Meeting Template.md` | Default meeting note template with frontmatter and sections |

## Setup

Copy the files you want to use into your vault (e.g. a `Prompts/` folder for the prompt files). No user-specific values need to be changed — the microphone user name and other context are passed at runtime when the prompt is invoked.
