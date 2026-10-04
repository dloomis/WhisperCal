# Migrating Legacy Notes

> Applies to the MacWhisper recording source on macOS only. The shell snippets use macOS `sed` syntax.

If you have meeting notes that were created before WhisperCal (or before the unlinked recordings feature), they won't have a `macwhisper_session_id` in their frontmatter. This means their MacWhisper recordings will appear as "unlinked" even though a note exists.

## What WhisperCal expects

WhisperCal identifies a note as linked to a MacWhisper recording by the presence of `macwhisper_session_id` in its YAML frontmatter:

```yaml
---
macwhisper_session_id: "AABBCCDD11223344AABBCCDD11223344"
---
```

The value is a 32-character uppercase hex string — the MacWhisper session ID. Without this key, the recording shows up in the "Unlinked recordings" section.

## Finding session IDs

If your legacy notes already have transcript files linked via a `transcript` frontmatter key, the session ID is stored in the transcript's frontmatter. Transcripts written by current versions of WhisperCal use `macwhisper_session_id`; older transcripts use `session_id`, shown here:

```yaml
---
session_id: "AABBCCDD11223344AABBCCDD11223344"
---
```

You can also query the MacWhisper database directly to find session IDs by title:

```bash
sqlite3 -readonly ~/Library/Application\ Support/MacWhisper/Database/main.sqlite \
  "SELECT hex(id), userChosenTitle FROM session WHERE isTransient = 0 AND dateDeleted IS NULL ORDER BY dateCreated DESC;"
```

## Backfilling a single note

Add `macwhisper_session_id` to the note's existing frontmatter block:

```yaml
---
meeting_subject: "Weekly Standup"
meeting_date: 2026-01-15
macwhisper_session_id: "AABBCCDD11223344AABBCCDD11223344"
---
```

The note will disappear from the unlinked list on the next calendar view refresh.

## Bulk backfill from transcript files

If your legacy transcripts have `session_id` in their frontmatter, you can backfill all matching meeting notes at once. This script reads the session ID from each transcript and writes it to the corresponding meeting note:

```bash
VAULT=~/path/to/vault
NOTES="$VAULT/Meetings"
TRANSCRIPTS="$VAULT/Transcripts"

for transcript in "$TRANSCRIPTS"/*.md; do
  # Extract session_id from transcript frontmatter
  sid=$(grep -m1 'session_id:' "$transcript" | sed 's/.*session_id: *"\(.*\)"/\1/')
  [ -z "$sid" ] && continue

  # Find the meeting note linked from the transcript
  note_link=$(grep -m1 'meeting_note:' "$transcript" | sed 's/.*\[\[\(.*\)\]\].*/\1/')
  [ -z "$note_link" ] && continue

  note_file="$NOTES/${note_link}.md"
  [ -f "$note_file" ] || continue

  # Skip if already has macwhisper_session_id
  grep -q 'macwhisper_session_id:' "$note_file" && continue

  # Insert macwhisper_session_id after the opening ---
  sed -i '' "1,/^---$/{/^---$/a\\
macwhisper_session_id: \"$sid\"
}" "$note_file"

  echo "Patched: $(basename "$note_file") <- $sid"
done
```

## Bulk backfill by matching titles

If your legacy notes don't have transcript files but you named MacWhisper recordings to match your note filenames, you can match by title:

```bash
VAULT=~/path/to/vault
NOTES="$VAULT/Meetings"
DB=~/Library/Application\ Support/MacWhisper/Database/main.sqlite

sqlite3 -readonly "$DB" \
  "SELECT hex(id), userChosenTitle FROM session WHERE isTransient = 0 AND dateDeleted IS NULL AND userChosenTitle IS NOT NULL;" \
  | while IFS='|' read -r sid title; do
    # Try to find a note whose filename contains the session title
    match=$(find "$NOTES" -name "*.md" -maxdepth 1 | while read f; do
      bn=$(basename "$f" .md)
      # Strip hex suffixes from old naming schemes
      clean=$(echo "$bn" | sed 's/\.[a-f0-9]\{3,6\}$//')
      if [ "$clean" = "$title" ]; then
        echo "$f"
        break
      fi
    done)
    [ -z "$match" ] && continue
    grep -q 'macwhisper_session_id:' "$match" && continue

    sed -i '' "1,/^---$/{/^---$/a\\
macwhisper_session_id: \"$sid\"
}" "$match"

    echo "Patched: $(basename "$match") <- $sid"
  done
```

## Using the Link button instead

You can also backfill one at a time using the **Link** button in the unlinked recordings section. This has the advantage of creating a transcript file and completing the full linking flow. However, it creates a new meeting note if one doesn't already exist — so it works best for recordings that genuinely don't have notes yet.
