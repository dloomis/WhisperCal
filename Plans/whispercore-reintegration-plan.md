# Fold WhisperCore back into WhisperCal

**Written:** 2026-10-03 · **Status:** Phases 1–4 implemented (uncommitted), except the version bump, changelog, and the WhisperCore repo notice, which wait for the release; Phase 5 pending · **Baseline:** WhisperCal 0.8.7 (`bd13e5c`), WhisperCore 0.1.0 (`1af6526`)

## Why

WhisperCore was split out (C1–C5, July 2026) so WhisperCal and WhisperOrg could share one sign-in and one LLM config. In practice the hard prerequisite makes WhisperCal's install confusing: two plugins, neither in the community directory, an enable-order rule, a "WhisperCore required" gate, and settings split across two tabs. This plan reverses WhisperCore DESIGN decision **D2** (hard prerequisite) and makes WhisperCal self-contained again.

## Goal

- A fresh user installs **one** plugin, and every calendar and LLM setting is in WhisperCal's own settings tab.
- An existing user upgrades with **no re-login and no re-entry** of anything.
- The upgrade never writes to WhisperCore's data, so downgrading to 0.8.x still works.

## What comes back

All of it is small: Core's `src/` is about 1,900 lines, and 700 of those are its settings tab.

| From WhisperCore | Lands in WhisperCal | Notes |
|---|---|---|
| `src/auth/AuthTypes.ts`, `BaseCalendarAuth.ts`, `MsalAuth.ts`, `GoogleAuth.ts`, `LoopbackOAuthServer.ts` | `src/services/auth/` | Port Core's **current** files. Do not revert C3 (`2a921a8`): Core's engine has since gained the redirect-URI fix (`44837cf`), the `Chat.Read` scope, error codes on `AuthState`, and single-flight refresh. |
| `src/llm/AnthropicModels.ts` | `src/services/AnthropicModels.ts` | Model listing and key fingerprinting. |
| Provider fields: `tenantId`, `clientId`, `cloudInstance`, `googleClientId`, `googleClientSecret` | `WhisperCalSettings` | Same key names WhisperCal used before C3. |
| LLM fields: `anthropicApiKey`, `llmCli`, `llmExtraFlags`, `llmPromptDir`, `llmTimeoutMinutes`, `llmMaxConcurrent`, `llmDebugMode`, `llmDebugLogging` | `WhisperCalSettings` | Use Core's load-time validation (cloud enum, numeric sanitizing). Core's key-validation status UI and its `anthropicKeyValidatedFingerprint` were not ported; the model dropdowns show whether the key works. |
| `microsoftTokenCache`, `googleTokenCache` | Top-level keys in WhisperCal's `data.json`, outside `settings` | Same layout as before C3. |
| Settings UI: provider fields, connection status row, key validation, prompt dir, LLM engine rows | `src/settings.ts`, replacing the "Managed in WhisperCore" cards | Rename `whispercore-` CSS to `whisper-cal-`. Use WhisperCal's existing `FolderSuggest`. |

## What goes away

- `src/services/CoreBridge.ts`, `src/services/CoreCalendarAuth.ts`, `src/types/whispercore.ts` (the types file stays if Phase 5 option A is chosen).
- The install gate in `CalendarView` (`:230`, `:352`, `:578`) and its CSS (`styles.css:692`).
- The "Managed in WhisperCore" mirrors in `settings.ts` (`:1037`–`:1296`) and their CSS (`styles.css:824`, `:838`).
- `runCoreHandoff` / `doCoreHandoff` / `LEGACY_LLM_KEYS` / `coreHandoffInFlight` in `main.ts`, and the `whispercore:ready` / `whispercore:auth-changed` bridges (`main.ts:224`–`244`).
- The Core gate in `runLlmJob` (`main.ts:2160`) and `coreLlm()` (`main.ts:726`); callers read `this.settings` directly.
- WhisperCore wording in notices (`MeetingChat.ts:334`, `main.ts:2219`) and comments (`LlmTransport.ts`, `CalendarAuth.ts`, `AutoSpeakerTagger.ts`).

## Phases

Each phase builds and lints on its own. Phases 1–4 ship together as one release. Phase 5 is separable.

### Phase 1 — Restore the auth engine

1. Copy the five auth files into `src/services/auth/`. Merge Core's `AuthErrorCode` and the `code` field on the error state into WhisperCal's existing `CalendarAuth.ts`.
2. Change `createCalendarStack(type, app)` back to taking provider config and `AuthCallbacks`, and construct `MsalAuth` or `GoogleAuth` for the **selected** provider only. `rebuildProviderStackIfChanged` already handles switching.
3. Wire `loadTokenCache` / `saveTokenCache` through `persistData`, and `onStateChange` straight into `notifyAuthStateListeners`.
4. Push provider config into the live auth instance on `saveSettings` (the "nothing to push here" comments at `main.ts:605` and `:740` mark the spots).
5. Call `cancelSignIn()` in `onunload` so the loopback port is released.

`GraphApiProvider`, `GoogleCalendarProvider`, and both people-search providers depend only on the `CalendarAuth` interface and need no changes.

### Phase 2 — Restore LLM config

1. Add the nine LLM fields to `WhisperCalSettings` and `DEFAULT_SETTINGS`.
2. Replace every `coreLlm()` / `getLlmConfig()` read with `this.settings`. Replace `listModels?.()` (`settings.ts:1183`) with a direct call to the ported `AnthropicModels`.
3. Delete the `runLlmJob` gate. The existing "CLI not found" check stays.

### Phase 3 — Import from WhisperCore (the upgrade path)

This is the reverse of the C3 hand-off and the part that most needs care.

**Mechanism.** In `onload`, after `loadSettings` and before the auth stack is built, if `settings.coreImportDone` is false, read `<configDir>/plugins/whispercore/data.json` through `app.vault.adapter`. Reading the file rather than calling Core's API is deliberate: the API never exposes refresh tokens, and the file read works whether Core is enabled, disabled, or not yet loaded, so there is no load-order race.

**Rules.**
- Fill **empty** WhisperCal slots only. Core's `data.json` uses the same key names, so this is a field-by-field copy.
- Adopt a token cache only when WhisperCal's resulting client id, tenant, and cloud (or Google id and secret) equal Core's. Reuse the identity check from Core's `importConfig`.
- Validate on intake: cloud enum, numeric ranges, token cache shape.
- Never write to or delete Core's `data.json`.
- Set `coreImportDone` once the file was imported or found absent. A read or parse error leaves it false so the next load retries.

**Three populations.**

| User state | What happens |
|---|---|
| Already migrated to Core (`coreMigrationDone: true`, keys removed from WhisperCal) | Import from Core's file. Signed in on first load. |
| Never installed Core (legacy keys still in WhisperCal's `data.json`) | `loadSettings` reads those keys again and they work in place. Keep the legacy `tokenCache` → `microsoftTokenCache` fallback from `doCoreHandoff`. |
| Fresh install | Nothing to import. Marks done. |

**After import.** If the `whispercore` plugin is installed, show a one-time notice: WhisperCal no longer needs WhisperCore, settings were imported, and it can be uninstalled unless WhisperOrg is in use.

**To verify during implementation.**
- **Resolved:** `llmTimeoutMinutes`, `llmMaxConcurrent`, and the debug toggles were not stripped by `2dd1a90`; stale copies remain in WhisperCal's `data.json`. The import therefore treats Core as authoritative when `coreMigrationDone` is true (Core's values replace WhisperCal's), and fills only fields still at their default otherwise.
- Whether either provider's `signOut` revokes the refresh token server-side. After import, Core and WhisperCal hold the same refresh token; if sign-out revokes, signing out in one silently signs out the other. Acceptable, but it should be known and documented.
- That the Microsoft redirect URI stays `http://localhost:<port>` exactly, so existing Azure app registrations keep working.

### Phase 4 — Settings UI, docs, release

1. Rebuild the Calendar tab's provider section and the LLM engine tab with editable fields, ported from Core's settings tab. Sign-in and sign-out are offered in settings again, as well as in the sidebar banner.
2. `manifest.json` `minAppVersion` stays `1.6.0`. Confirm the ported settings code uses nothing newer (Core declared 1.9.0).
3. README: remove the "WhisperCore (Required Companion Plugin)" section, the install callouts, the gate troubleshooting entry, and the *(WhisperCore)* markers (about 70 mentions). Add a short "Upgrading from 0.8.x" note: **update WhisperCal before uninstalling WhisperCore**, or the import has nothing to read.
4. CLAUDE.md: replace the "WhisperCore dependency" section and the `CoreCalendarAuth` references.
5. Changelog in the curated style. This removes a dependency and changes where settings live, so a minor bump (0.9.0) is worth considering over the default patch.
6. WhisperCore repo: README notice that WhisperCal 0.9+ no longer requires it. Archive or keep per Phase 5.

### Phase 5 — WhisperOrg (decided 2026-10-03: option A)

WhisperOrg 0.2.0 also consumes Core: `getAccessToken`, `getConnectionInfo`, `isSignedIn`, and `getLlmConfig`, through `src/core/coreBridge.ts`. Phases 1–4 do not break it, since Core keeps working standalone. But a user with both plugins would then sign in twice and configure the LLM twice.

| Option | What it means | Trade-off |
|---|---|---|
| **A. WhisperCal hosts the API** (recommended) | WhisperCal exposes the same v1 surface as `plugin.api` (minus `importConfig`) and fires the same two events. WhisperOrg's bridge looks up `whisper-cal` instead of `whispercore`. WhisperCore is archived. | One sign-in, two plugins at most. WhisperOrg's directory and LLM features then require WhisperCal, which matches its "companion plugin for WhisperCal" positioning and the freemium ladder. WhisperOrg loses LLM config on mobile, since WhisperCal is desktop-only. Only the selected provider reports as signed in. |
| B. Core stays for WhisperOrg only | No WhisperOrg changes. Core remains a maintained third plugin. | Duplicate sign-in and LLM config for users of both. Two copies of the auth engine to keep in sync. |
| C. WhisperOrg vendors its own auth | Each plugin fully standalone. | Third copy of the engine; duplicate sign-in. |

Under option A, WhisperOrg's bridge can fall back to `whispercore` when `whisper-cal` has no `api`, which lets the two releases ship in either order.

## Manual test matrix

There is no test suite, so each row is a manual check in a scratch vault, then in `~/SDA`.

| Scenario | Expect |
|---|---|
| Fresh install, no Core, Microsoft | Configure and sign in entirely within WhisperCal. Calendar loads. |
| Fresh install, Google | Same. |
| Upgrade with Core enabled and signed in (GCC High, `~/SDA`) | Calendar loads with no prompt. Provider and LLM fields are populated. Notice appears once. |
| Upgrade with Core installed but disabled | Same as above. |
| Upgrade from pre-C3 data (legacy keys, no Core) | Signed in, no prompt. |
| Upgrade after Core's folder was deleted | Signed out, fields empty, no errors. |
| Core's `data.json` corrupt | Warning in console, import retried next load, plugin otherwise works. |
| Token refresh after import (force expiry) | Refresh succeeds. Core, if still enabled, also still refreshes. |
| Switch provider Microsoft ↔ Google | Stack rebuilds. Each provider's token cache survives the switch. |
| LLM: speaker tag, summary, research, model dropdowns, key validation | All work with no Core present. |
| Teams chat fetch | `Chat.Read` scope still present on the imported token. |
| Downgrade to 0.8.7 with Core still installed | Works as before. |
| Windows | Sign-in loopback and LLM spawn work. |

## Risks

- **Uninstalling Core before upgrading WhisperCal** loses the only copy of the tokens and config. Mitigation is the README note and release notes; there is no technical fix.
- **Engine drift during the port.** The auth files should be copied verbatim and only their imports changed, so a diff against Core stays reviewable.
- **Supersedes prior decisions.** WhisperCore DESIGN D2 and D7, and the "Core = free plumbing" line in the freemium model, need updating once Phase 5 is decided. The planned Core API v2 `runLlmPrompt` primitive (`LlmTransport.ts` header) no longer has a home; `LlmTransport` stays internal to WhisperCal.
