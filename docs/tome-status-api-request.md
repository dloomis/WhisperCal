# Request: include the active recording's subject in Tome's `/status` response

**To:** Tome recording API maintainer
**From:** WhisperCal (Obsidian plugin integrating Tome recordings into a meeting workflow)
**Type:** Small, additive, backward-compatible API enhancement

## Summary

When a recording is in progress, please have `GET /status` echo back the **subject/title of the meeting currently being recorded**. Tome already receives this string from WhisperCal at record-start; this request is just to return it in the status payload so the user can be shown *which* meeting is recording.

## Background — why this helps

WhisperCal lets the user start a recording from a meeting card. Because Tome owns the microphone and the recording lifecycle, WhisperCal asks Tome for its live state at the moment the user clicks **Record**, rather than guessing from its own (drift-prone) state.

If Tome is already recording, WhisperCal shows a confirmation dialog and lets the user decide whether to proceed. Today that dialog can only say a generic *"The recording service is already recording. Start a new recording anyway?"* — because Tome's `/status` returns only the state, not what's being recorded.

If `/status` returned the subject, the dialog could instead say:

> **Recording already in progress**
> The recording service is already recording **KM P&SpC2E Leadership Stand-up**. Start a new recording anyway?

That single detail is what tells the user whether they simply forgot to stop the previous meeting, or whether it's a stale/finished session that's safe to record over.

## The data is already on Tome's side

WhisperCal sends the subject to Tome at record-start. From WhisperCal's `POST /start` call:

```jsonc
// POST {baseUrl}/start
{
  "suggestedFilename": "2026-06-29 1600 - KM P&SpC2E Leadership Stand-up - Transcript",
  "meetingContext": {
    "subject": "KM P&SpC2E Leadership Stand-up",
    "attendees": ["Steve Martin", "Dan Loomis", "…"]
  }
}
```

So the request is just: **stash `meetingContext.subject` (and/or `suggestedFilename`) at `/start`, and return it from `/status` while that recording is active.**

## Requested change

### Current `/status` response

```json
{ "state": "recording" }
```

### Proposed `/status` response (while recording)

```json
{
  "state": "recording",
  "recording": {
    "subject": "KM P&SpC2E Leadership Stand-up",
    "suggestedFilename": "2026-06-29 1600 - KM P&SpC2E Leadership Stand-up - Transcript",
    "startedAt": 1751230800000
  }
}
```

- The `recording` object only needs to be present when `state` is `"recording"` (optionally also `"transcribing"`). When idle, it can be omitted.
- `subject` is the field that matters most; `suggestedFilename` is a nice-to-have fallback.
- `startedAt` is **epoch milliseconds** when capture actually began (see "Recording timer sync" below). Epoch **seconds** are also accepted (WhisperCal normalizes). Optional but recommended.
- No other states or fields need to change.

### Recording timer sync (why `startedAt` helps)

WhisperCal shows an elapsed-time counter on the recording card. Today it anchors that counter to its own clock at the moment it issues `/start`, which is offset from when Tome actually began capturing (by the start-call latency) — so WhisperCal's timer and Tome's on-screen timer drift a second or two apart and disagree on which is ahead.

Because both apps run on the same machine, if `/status` reports the capture's **absolute start time** (`startedAt`, epoch ms), WhisperCal can anchor its counter to Tome's clock and the two stay locked together. WhisperCal already polls `/status` every ~2s while recording, so it re-syncs automatically — no extra endpoint needed. When `startedAt` is absent, WhisperCal keeps its own (slightly offset) anchor, exactly as today.

## WhisperCal is tolerant about the exact shape

WhisperCal parses both fields defensively, so the maintainer has flexibility.

**Subject** — first non-empty string found among:

- **Top-level:** `subject`, `meeting`, or `title`
- **Nested** under `recording`, `currentRecording`, or `meetingContext`: `subject`, `suggestedFilename`, or `title`

**Start time** — first positive number found among:

- **Top-level:** `startedAt`, `startTime`, or `started_at`
- **Nested** under `recording` or `currentRecording`: `startedAt`, `startTime`, or `started_at`
- Accepted as epoch **ms** or epoch **seconds** (auto-normalized).

Any one of these works. The nested `recording.{subject,startedAt}` form shown above is the preferred/cleanest.

## Backward compatibility — this is safe to ship anytime

This change is **purely additive and non-breaking**:

- WhisperCal already handles `/status` responses that **omit** `subject` (falls back to the generic dialog text) and/or `startedAt` (keeps its own local timer anchor).
- WhisperCal already handles older Tome builds that **lack `/status` entirely** (a 404 / unreachable / unexpected body is caught and treated as "not recording" — the user is never blocked and nothing crashes).

So Tome can add either field whenever convenient, with no coordinated release between the two projects.

## Related (optional, lower priority): allow `/start` during post-processing

WhisperCal also supports starting a new recording while a previous one is still **transcribing / post-processing** — useful for back-to-back meetings, so the user doesn't have to wait for the prior transcript to finish before recording the next meeting. This currently requires a local patch to Tome's `/start` (stock Tome rejects a new recording until the prior session fully completes).

If this could be supported upstream, WhisperCal already defers the decision to Tome: it never pre-blocks, and on the user's confirmation it simply calls `/start`. (Note: because `/status` is a single global state, two *simultaneously active captures* are still ambiguous to poll — capture-vs-post-processing overlap is the important case.)
