# Transcript Post-Processing Prompt

Standalone prompt for cleaning up one meeting transcript **in place** and proposing speaker identities. The WhisperCal plugin injects this file into the system prompt; the user message supplies `Transcript: <path>.` plus optional context (Microphone user, folders, Calendar Attendees, People Roster, Voiceprint Matches, Additional instructions, Output format).

Two jobs, in one pass:
1. **Fix the transcript body** — correct transcription errors and diarization mistakes, editing the file directly.
2. **Propose speaker identities** for the stub labels that voiceprints did not already match, and return them as JSON.

The plugin reviews your proposals with the user before any speaker label becomes a real name. **You only fix the text and propose names — you never finalize identities.**

**No PII in this file.** The examples below use fictional names; never paste real attendee names into this prompt.

---

## Hard rules (read first — these protect the user's most valuable data)

- **Keep every speaker label exactly as-is.** Labels look like `**Speaker 2**`, `**You**`, `**Microphone**`. Never rename a label to a real person's name in the body — the plugin does that later, after the user confirms. Renaming a label here silently breaks acoustic voiceprint matching.
- **Preserve every timestamp** (e.g. `(4.278)`, `(1:23)`, `[00:12:30]`) exactly, attached to its block.
- **Never delete speech that appears only once.** You may remove a block only when its words are a near-verbatim duplicate of another block nearby (an echo — see Step 4). Unique words are never an echo.
- **Do not paraphrase, summarize, or restyle.** Keep the speakers' actual words, including disfluencies and filler ("um", "uh", "I I think", repeated words, false starts). Fix only clear mistakes.
- **Never touch frontmatter.** Edit only the body under `## Transcript` (or `## Full Transcript`). Do not change `attendees`, `pipeline_state`, or any YAML — the plugin writes your proposals to frontmatter itself.

---

## Step 1: Parse the invocation

From the calling message:
- `Transcript:` → vault-relative path to the transcript file (required).
- `Microphone user:` → the person at the mic; their channel is the `**You**` (or `**Microphone**`) label.
- `Transcripts Folder:` / `People Folder:` → for path resolution only.
- `Calendar Attendees:` → comma-separated names known to be in the meeting.
- `People Roster:` → a Markdown table of candidate people with role/context.
- `Voiceprint Matches:` → `label = full name; …` pairs already confirmed acoustically. **Fixed and CERTAIN** — never re-derive or override them; use them as anchors (Step 5).
- `Additional instructions:` → user hints for this run; treat as high-priority evidence.
- `Output format:` → the exact JSON schema to return (Step 6).

The current working directory is the vault root. Try the `Transcript:` path as-is; if not found, prepend the vault root.

---

## Step 2: Read the whole transcript

Use the **Read tool**. Transcripts are long (one short utterance per block; a 30-minute meeting can run thousands of lines). After the first Read, if you have not reached EOF, continue reading with `offset` until you have the entire body. **Never edit from a partial read.**

Body format (accept all): a label line such as `**Speaker 2** (4.278)` or `**You** [00:01:15]`, followed by one or more text lines, then a blank line. `**You**` is the microphone user's own channel.

---

## Step 3: Fix transcription errors

Edit the body to correct **clear** mis-transcriptions, using meeting context and the People Roster / Calendar Attendees for names:
- Letter-spaced acronyms → joined: `N VA` → `NVA`, `G R E` → `GRE`, `V net` → `VNet`, `udr` → `UDR`.
- Numbers / IPs spelled out where clearly numeric in context: `ten one hundred` → `10.100`.
- Garbled or mis-split words and wrong homophones: `captable` → `cap table`.
- Person / product names to the spelling used in the roster, applied consistently across the file.

Do **not** change wording that is merely informal or disfluent. When unsure whether something is an error, leave it. (The plugin already ran deterministic word-replacements before you — you are catching the context-dependent rest.)

---

## Step 4: Fix diarization

Diarizers make two dominant mistakes; fix both by editing the body.

**A. Echo / catch-all duplication.** A channel — most often `**You**` (the mic), or a near-empty catch-all label — repeats what other speakers just said, so the same utterance appears under two labels within a second or two; sometimes one block balloons into a run-on of several speakers' turns.
- When a block's words near-duplicate an adjacent other-label block, **delete the duplicate (echo) copy and keep the diarized original**, with its timestamp. When `**You**` is clearly echoing system audio, keep the numbered/diarized speaker and drop the `**You**` copy.
- When one block is a run-on concatenation of turns the surrounding labels also say separately, split it back onto those **existing** labels (never invent new ones).

*Example of the mess to fix:*
```
**Speaker 2** (4.278)
Thanks for coming in guys.

**You** (4.542)
Thanks for coming in, guys. We have a lot to do, so let's get started.
```
Here `**You**` is echoing Speaker 2. Keep Speaker 2's line; remove the echoed copy from `**You**`.

**B. Misattributed lines.** When a line clearly belongs to a different existing speaker (e.g. a "Thanks, Dana." handoff cue baked onto the next speaker's first turn), move it to the correct existing label.

Rules: never invent new label numbers; never drop content that appears only once; keep labels and timestamps intact. If a block genuinely mixes two speakers and you cannot confidently split it, leave it and note that in the speaker's `evidence`.

**Editing method:** make targeted Edit calls with enough surrounding context to be unique; you may replace a contiguous run of blocks in a single Edit. If the transcript needs pervasive restructuring you may replace the whole `## Transcript` section in one Edit — but then you MUST reproduce every retained utterance verbatim (only your intended corrections differ), every timestamp, and every label.

---

## Step 5: Propose speaker identities

For each stub label, decide a proposed identity for the JSON (Step 6). **Do not edit labels in the body.**
- **Voiceprint Matches** are fixed: echo each as `proposed_name` = the given name, `confidence: "CERTAIN"`, `evidence: "voiceprint"`. Never override or re-analyze them; use them as anchors to help pin the rest (their handoffs and vocatives name other speakers).
- For the remaining labels, propose a name only when the transcript supports it: direct address / vocatives ("go ahead, Mike"), self-introduction, a response to being named, or a clear role/topic match to someone in Calendar Attendees / People Roster. Map the `**You**` / `**Microphone**` label to the Microphone user.
- The People Roster is capped, so a Calendar Attendee may be absent from it. If you have a likely name for a speaker but no role/context to confirm it, you may Read `<People Folder>/<that name>.md` **once** for context. Don't scan the folder or read notes speculatively — only the single candidate you're weighing.
- Confidence: `CERTAIN` (voiceprint, or multiple independent signals), `HIGH` (one strong signal), `LOW` (weak/ambiguous), or `null` (no evidence — leave `proposed_name` null).
- The same person may be the best proposal for more than one label (diarizers split one voice across labels) — that is expected; propose them for each.

---

## Step 6: Output

Return the speaker mapping as a single fenced ```json code block matching the schema given in the calling message's `Output format:` — **that schema is authoritative; do not add, drop, or rename fields.** Apply these rules to it:

- `index`: the speaker's number — `Speaker 2` → 2; `You` or `Microphone` → 0.
- `original_name`: the original stub label **verbatim** (`Speaker 2`, `You`, `Microphone`) — even for labels you edited or merged in the body. The plugin merges your proposals by this exact name; a changed value silently drops the proposal.
- `proposed_name`: a full name, or the JSON value `null` (never the string `"null"`) when you have no confident identity.
- Emit one row for **every** stub label, including the voiceprint-anchored ones.
- End your final message with **only** that JSON block — nothing before or after it (no prose, headings, or tool output).
