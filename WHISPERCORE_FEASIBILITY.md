# WhisperCore — Shared Connection Layer Feasibility Report

**Date:** 2026-07-11 · **Status:** SUPERSEDED (2026-07-11) by `../WhisperCore/DESIGN.md`, which folds in this report's survey and resolves its open questions (thin Core, hard prerequisite, LLM creds/config only, desktop-gated auth, freemium tier ladder). Kept for provenance only. Original scope: "can the current WhisperCal Calendar-provider and LLM creds/connection move to WhisperCore instead of being implemented natively here."
**Repos:** WhisperCal `/Users/dloomis/Projects/WhisperCal` (id `whisper-cal`, desktop-only, 0.8.7 @ `2009ddb`) · WhisperCore `/Users/dloomis/Projects/WhisperCore` (id `whispercore`, `isDesktopOnly:false`, 0.1.0 — scaffolding only) · WhisperOrg `/Users/dloomis/Projects/WhisperOrg` (id `whisperorg`, cross-platform).
**Line numbers** reference code as of the survey date — re-verify before editing.

---

## Verdict

**Feasible, and unusually low-risk.** The codebase is already shaped for it, and the exact inter-plugin mechanism required is already specified (and about to be built) for the WhisperOrg integration (`WHISPERORG_INTEGRATION_PLAN.md`). The open questions are *optional-vs-required dependency* and *mobile support* — not *can it be done*.

The vision: the user logs in **once** in WhisperCore; both WhisperCal and (future) WhisperOrg leverage that one OAuth connection and one LLM credential set for their own needs, instead of each plugin making the user authenticate separately against the same provider.

Important current-state fact: **WhisperOrg today has no OAuth and no LLM connection of its own.** Its only "LLM" surface is generated guide files (`LLM_GUIDE.md`, enrichment contract) that external agents read — a file-based contract, not a live provider connection. So the provider/contacts + LLM integration is a *future* WhisperOrg need that Core would serve, and today only WhisperCal has the real implementation to lift.

---

## 1. The inter-plugin pattern is real and already in-flight in this ecosystem

`app.plugins.getPlugin("whispercore").api` is the standard Obsidian plugin-to-plugin pattern (Dataview is the canonical public example). It does not need to be proven out here because **`WHISPERORG_INTEGRATION_PLAN.md` already fully specifies the same machinery** for a different plugin id:

- `OrgBridge` lazy-fetch helper (§5.1) — the single place that touches the registry, called fresh at every use, never cached across awaits.
- A **vendored, dependency-free type block** hand-copied from the provider plugin (avoids broken npm typings — see the Dataview issue #2209 rationale in that plan's §1.4).
- Runtime **`apiVersion` drift check** as the guard against the two bundles disagreeing.
- Graceful handling of absent / disabled / not-ready / version-mismatched.

**A WhisperCore connection API is the identical plumbing pointed at a second plugin id.** Whatever is built for WhisperOrg's public-API milestone (its M1 / WhisperCal M2 in that plan) is a directly reusable template for Core. This is the single biggest reason the effort is low-risk: the hard, subtle part (load order, drift, cross-bundle DTO discipline) is already solved on paper.

---

## 2. The auth code is already decoupled from where tokens live

This is the strongest feasibility signal in the current implementation — it almost anticipates the move.

- **`BaseCalendarAuth` takes `AuthCallbacks`** (`loadTokenCache` / `saveTokenCache` / `onStateChange`) — token persistence is *injected*, not hardwired (`src/services/BaseCalendarAuth.ts:7-11,29,70-73`). Today `main.ts` points those callbacks at its own `data.json` (`main.ts:164-166,440-442,616-635`). Relocating the store to Core is swapping the callback implementation, not rewriting auth.
- **`CalendarProviderFactory.createCalendarStack()`** is one provider-agnostic factory; Microsoft (`MsalAuth`) and Google (`GoogleAuth`) already sit behind a single seam (`src/services/CalendarProviderFactory.ts:19-51`).
- **The token cache is a trivial portable JSON blob** — `{accessToken, refreshToken, expiresAt}` (`src/services/AuthTypes.ts:1-5`). Nothing plugin- or vault-specific; drops straight into Core's `data.json`.
- **The consumer surface is tiny.** `GraphApiProvider` only ever needs a *bearer token* (`auth.getAccessToken()`) plus the cloud base URL — it never touches the refresh token or the loopback flow. So Core can own the entire OAuth dance (loopback server, PKCE, refresh rotation, token store) and expose roughly: `getAccessToken(provider)`, `getGraphBaseUrl()` / cloud info, `isSignedIn(provider)`, `searchContacts(provider, query)`. WhisperCal's `MsalAuth` / `GoogleAuth` / `GraphApiProvider` / `GraphPeopleSearch` collapse into thin wrappers over that surface.

**Why "log in once" works:** the **refresh token is the shareable asset.** Hold it in Core; hand out short-lived access tokens on demand. Consumers never see or manage the long-lived grant.

---

## 3. The LLM "connection" is two different things — be precise about which moves

- **Primary pipeline LLM = a spawned CLI child process** (`llmCli: "claude"` + flags; `LlmInvoker.spawnLlmPrompt`). The actual *credential* here lives in the `claude` CLI's own on-disk auth (subscription login) — it is **already global to the machine, not owned by the plugin.** For this path Core would share *config* (which CLI, model, flags), not a secret.
- **`anthropicApiKey` setting = a real shared secret** (`src/settings.ts:47,139`), currently used narrowly for a direct HTTP model-listing call (`main.ts:1212-1219`). Genuinely shareable; belongs in Core.

`LlmInvoker` itself (622 lines: process-tree kills, Windows PowerShell UTF-8 quoting, MCP config plumbing) is exactly the duplication Core *should* absorb — but it is deeply coupled to WhisperCal's prompt-file/trigger conventions. Realistic scope: **Core owns LLM credentials + connection config (and possibly a generic spawn/complete primitive); each plugin keeps its own prompt orchestration.** Do not try to lift all of `LlmInvoker` into Core in one move.

---

## 4. Frictions to weigh (caveats, not blockers)

| Concern | Assessment |
|---|---|
| **Optional vs. required dependency** | The real tension. The WhisperOrg integration is deliberately *optional* (works if absent). But if Core is the *only* place the user logs in, Core becomes a **hard prerequisite** — and Obsidian has no dependency manager, load-order guarantee, or auto-install. Either (a) treat Core as a documented prerequisite with an "install/enable WhisperCore" gate, or (b) keep a native fallback in each plugin (partly defeats the dedup goal). Recommend (a) for the connection layer specifically. |
| **Mobile / desktop-only** | The OAuth loopback flow uses Node `http.createServer` (`LoopbackOAuthServer.ts`) + `child_process` + Electron `shell.openExternal` (`MsalAuth.ts:82-89`) — **desktop-only APIs**. WhisperCal is already `isDesktopOnly:true`, so no regression. But WhisperCore and WhisperOrg are both `isDesktopOnly:false`. If Core owns auth, either Core's auth capability becomes desktop-gated, or mobile needs a different redirect (`obsidian://` protocol handler). Fine for the current desktop reality; a real constraint on the "cross-platform Core" aspiration. |
| **Scope consolidation** | Core must request the *union* of scopes (WhisperCal: `Calendars.Read People.Read User.ReadBasic.All offline_access`, `MsalAuth.ts:41-44`; WhisperOrg will want contacts). One app registration, one consent — a deliberate choice; means one clientId/tenant config in Core instead of per-plugin. |
| **Google client secret** | The Google loopback flow carries `googleClientSecret` (`settings.ts:32`). Core holds it once instead of each plugin. No new risk. |
| **Token security posture** | Tokens move from WhisperCal's `data.json` to Core's `data.json` — still plaintext in the vault, same as today. Consolidated, not weakened. |
| **GCC High / sovereign clouds** | `CLOUD_ENDPOINTS` already covers Public/USGov/USGovHigh/USGovDoD/China (`AuthTypes.ts:29-50`). Core must carry this `cloudInstance` config, not assume commercial hosts — the user's tenant is GCC High (`.us` gov-cloud). |
| **Clean layering with WhisperOrg** | Coherent split: **Core = raw provider *connection*** (calendar events, contacts-search results as plain JSON DTOs); **WhisperOrg = identity/canonicalization** over those results; **WhisperCal consumes both.** No overlap once the line is "Core returns provider data, WhisperOrg decides who the person is." |

---

## 5. What the move concretely touches in WhisperCal (inventory, not a plan)

- `src/services/MsalAuth.ts` (204 L), `GoogleAuth.ts` (200 L), `BaseCalendarAuth.ts` (114 L), `CalendarAuth.ts`, `LoopbackOAuthServer.ts` (117 L), `AuthTypes.ts` — the auth machinery that would relocate to Core.
- `CalendarProviderFactory.ts`, `GraphApiProvider.ts`, `GoogleCalendarProvider.ts`, `GraphPeopleSearch.ts`, `GooglePeopleSearch.ts` — become consumers of Core's token/contacts API.
- `main.ts` token wiring: `loadTokenCache`/`saveTokenCache`/`persistData` (`main.ts:616-638`), the `microsoftTokenCache`/`googleTokenCache` fields and the legacy-`tokenCache` migration (`main.ts:498-504`).
- Settings that would migrate to Core: `calendarProvider`, `tenantId`, `clientId`, `cloudInstance`, `googleClientId`, `googleClientSecret`, `anthropicApiKey`, `llmCli`, `llmExtraFlags`, `llmModel` (`settings.ts:20,27-32,47-49,139-141`).
- `LlmInvoker.ts` — credentials/config move; prompt orchestration stays.

---

## 6. Open question — the Core / plugin capability boundary

**Intent.** WhisperCore exists to hold capabilities that WhisperCal *and* WhisperOrg both need, so there is one implementation instead of duplication (per `../WhisperCore/CLAUDE.md`). This report establishes that the **provider connection** and **LLM credentials** are viable first tenants. It does **not** settle *which* capabilities belong in Core versus in the two consuming plugins — that boundary is an explicit open question to resolve in the design session, not here.

**The deciding principle (proposed, to confirm):** a capability belongs in Core only when it is (1) genuinely shared by both consumers, (2) a *connection/credential* concern rather than a *product/workflow* concern, and (3) expressible as plain-JSON DTOs across the bundle boundary (no `TFile`, no class instances, no `instanceof` across bundles — same rule as the WhisperOrg plan §1.5). Product logic, prompt orchestration, and identity semantics stay in the plugins. When unsure, keep it in the plugin — pulling into Core later is cheaper than untangling an over-broad Core API.

**Candidate capabilities and their proposed disposition — all OPEN pending design:**

| Capability | Lean | Rationale / what's unsettled |
|---|---|---|
| OAuth flow, token store, refresh rotation | **Core** | The shareable asset (refresh token); "log in once" only works if Core owns it. |
| Access-token vending (`getAccessToken(provider)`) | **Core** | Tiny consumer surface; the whole point of the layer. |
| Cloud-instance / endpoint config (`cloudInstance`, GCC High hosts) | **Core** | Travels with the connection; GCC High `.us` hosts must not be assumed away. |
| Calendar *event fetching* (`GraphApiProvider`, `GoogleCalendarProvider`) | **OPEN** | Is Core "raw provider access" (returns event DTOs) or only "auth, plugins call Graph themselves"? WhisperOrg may not need calendar events at all — only contacts. Decide whether calendar-read is a Core capability or WhisperCal-only over Core's token. |
| Contacts / people *search* (`GraphPeopleSearch`, `GooglePeopleSearch`) | **OPEN → likely Core** | Both consumers plausibly need it; but note the layering seam with WhisperOrg (below). Returns candidate DTOs; WhisperOrg does the identity resolution. |
| Identity resolution / canonical-name (who a contact *is*) | **WhisperOrg, never Core** | This is WhisperOrg's system-of-record role (see `WHISPERORG_INTEGRATION_PLAN.md`). Core returns provider results; WhisperOrg decides identity. Do not let contacts-search in Core bleed into identity. |
| LLM credentials (`anthropicApiKey`) + connection config (`llmCli`, model, flags) | **Core** | The one real shared secret + shared config. |
| LLM invocation machinery (`LlmInvoker`: process trees, quoting, MCP) | **OPEN** | Shareable in principle, but deeply coupled to WhisperCal's prompt-file/trigger conventions. Options: (a) Core owns a generic `spawn/complete` primitive both call; (b) Core owns only creds/config and each plugin keeps its own invoker. Lean (b) first, promote to (a) if WhisperOrg's needs converge. |
| Prompt orchestration, triggers, output parsing | **Plugins** | Product/workflow logic; not shared, not a connection concern. |
| Settings *storage* for the above | **Core owns the moved settings** | But confirm the migration path off WhisperCal's `data.json` (legacy `tokenCache` → `microsoftTokenCache` migration already exists at `main.ts:498-504`; a WhisperCal→Core move needs an analogous one-time hand-off). |

**Sub-questions that fall out of the boundary and must be answered in design:**
- Does Core expose **provider data** (event/contact DTOs) or only **auth** (tokens, and each plugin talks to Graph/Google itself)? This is the load-bearing fork — it decides how thick Core's API is.
- If Core vends contacts, where exactly is the seam with **WhisperOrg's identity layer** so the two don't both claim "people"? (Core = candidates; WhisperOrg = canonical person.)
- Is the LLM contribution a **primitive** (Core spawns) or just **config** (plugins spawn)?
- Migration/ownership hand-off: which plugin's existing `data.json` values move, and how is the one-time migration staged so a user upgrading mid-stream isn't logged out?

These are recorded here so the design session starts from the boundary question already framed, rather than rediscovering it.

## 7. Bottom line

Nothing in the current implementation fights this. The auth layer is already callback-injected and factory-abstracted; the inter-plugin API mechanism is already designed in `WHISPERORG_INTEGRATION_PLAN.md` and directly reusable; the token cache is a portable JSON blob; the LLM secret is a single narrow setting. The work is real but mechanical:

1. Lift OAuth / token-store / refresh machinery into Core behind a small `api`.
2. Reduce WhisperCal's auth classes to thin consumers of `core.api.getAccessToken()`.
3. Move `anthropicApiKey` + LLM config into Core.

The decisions that need human judgment before any design:
- **Where is the Core / plugin capability boundary?** — the central open question (§6): which shared capabilities are implemented in Core vs. left in WhisperCal / WhisperOrg. Everything else here is downstream of that call.
- **Is Core a hard prerequisite?** (Recommended: yes, for the connection layer — accept it as a documented dependency rather than duplicate a native fallback.)
- **How far does the mobile aspiration constrain a loopback-based OAuth flow?** (Loopback is desktop-only; mobile would need a protocol-handler redirect or a desktop-gated auth capability.)

## 8. References

- `WHISPERORG_INTEGRATION_PLAN.md` — the inter-plugin API pattern (`getPlugin().api`, vendored types, `apiVersion` guard, lazy fetch, graceful absence) that Core would reuse verbatim. §1.5, §5.1 especially.
- WhisperCal auth seam: `src/services/BaseCalendarAuth.ts`, `CalendarProviderFactory.ts`, `AuthTypes.ts`, `LoopbackOAuthServer.ts`, `MsalAuth.ts`, `GoogleAuth.ts`.
- WhisperCal LLM seam: `src/services/LlmInvoker.ts`, `src/settings.ts` (`anthropicApiKey`, `llmCli`, `llmExtraFlags`), `main.ts:1212-1219`.
- WhisperCore current state: `../WhisperCore/CLAUDE.md`, `main.ts` (scaffolding only — settings tab, no capabilities).
- Obsidian inter-plugin: `app.plugins` registry is community-standard but **unofficial** — treat every access as fallible (mirrors the WhisperOrg plan's §1.5 guards).
