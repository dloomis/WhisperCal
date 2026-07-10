# WhisperCal Windows Compatibility — Analysis & Execution Plan

**Goal:** Make WhisperCal fully functional on Windows with no loss of capability relative to macOS, except capabilities that are inherently macOS-bound (ingesting recordings made in the MacWhisper *app*).

**Assumptions (confirmed with Dan, 2026-07-10):**

- Tome (the companion recorder) is being ported to Windows separately. The plugin should assume transcripts, sibling `.m4a` audio, and `.voiceprints.json` sidecars get dumped into the transcript folder configured in settings — exactly as Tome does on macOS.
- Scope is **Windows only**. Linux is out of scope (don't break it gratuitously, but don't test or design for it).
- The MacWhisper recording source stays macOS-only. On Windows the "api" (Tome) source is the only source; the code already coerces this (`src/main.ts:500-502`) and hides the dropdown option (`src/settings.ts:652`).

**Execution note for the implementing agent:** every file/line reference below was verified against the codebase as of v0.8.6. Line numbers will drift as you edit — search for the quoted code, not the line number. Phases are ordered by dependency and severity; each is independently shippable. Run `npm run build` and `npm run lint` after each phase.

---

## 1. Current platform posture (verified inventory)

### 1.1 Already cross-platform — no work needed

| Area | Evidence |
|---|---|
| Meeting-app close on recording stop | `src/services/MeetingAppCloser.ts` — full `taskkill /IM` branch with per-platform process-name tables (`ms-teams.exe`, `Teams.exe`, `Zoom.exe`) |
| LLM CLI validation | `src/services/LlmInvoker.ts:120-139` — `where.exe` branch on Windows |
| CLI arg quoting | `LlmInvoker.ts:102-108` — `platformQuote()` has a cmd.exe branch |
| OAuth (Microsoft + Google) | `src/services/LoopbackOAuthServer.ts` — `http.createServer` on `127.0.0.1`, portable; `shell.openExternal` for the browser hop is a cross-platform Electron API |
| Meeting deep links | `src/utils/meetingLink.ts` — `msteams://`/`zoommtg://` schemes via `shell.openExternal`, work on Windows |
| Export save dialog + reveal | `src/services/MeetingExporter.ts:43-62,133-139` — `@electron/remote` `showOpenDialog` and `shell.showItemInFolder` are cross-platform; `join(homedir(), "Downloads")` exists on Windows |
| Vault path handling | Vault-relative paths are always `/`-separated by Obsidian regardless of OS; all filesystem joins use Node `path.join` |
| LLM temp files | `LlmInvoker.ts:53-57` — plugin tmp dir lives inside the vault, deliberately OS-agnostic |
| Transcript folder scanning, voiceprint sidecar pipeline | `ApiUnlinkedProvider`, `VoiceprintMatcher`, `VoiceprintEnroller` — all Obsidian-vault operations, portable |
| File discovery timing | Poll/event-based via Obsidian (`stat.ctime`/`mtime` epoch ms) — no raw `fs.watch`, no birthtime dependence on the api source path |
| Build system | `esbuild.config.mjs`, `package.json` scripts — plain node/tsc/eslint, run fine on Windows |

### 1.2 Correctly macOS-gated — stays as-is

| Area | Evidence | Why no work |
|---|---|---|
| MacWhisper SQLite source | `src/services/MacWhisperDb.ts` (sqlite3 CLI), `MacWhisperUnlinkedProvider.ts`, `constants.ts:15-17` | MacWhisper app doesn't exist on Windows; source coerced away at `main.ts:500-502` |
| "Link MacWhisper recording" command + file menu | `main.ts:254-289`, gated `Platform.isMacOS` | Same |
| MacWhisper settings pane (DB path display, match window, lookback) | `settings.ts:669-690` — inside the `macwhisperSettings` container, hidden when source is "api" | Same |

**Capability check:** the api/Tome source covers the entire pipeline — live start/stop/status, transcript production, sibling audio, voiceprint sidecars (a Tome-only capability MacWhisper never had), and speaker counts from frontmatter. Nothing in the Note → Transcript → Speakers → Summary pipeline is MacWhisper-dependent on the api source. The only true Windows non-capability is ingesting recordings captured in the MacWhisper app itself, which is accepted.

### 1.3 Broken or degraded on Windows — the work

| # | Severity | Area | Location |
|---|---|---|---|
| B1 | **Blocker** | LLM invocation uses a bash heredoc handed to cmd.exe — speaker tagging, summarize, and research all fail on Windows | `LlmInvoker.ts:260` |
| B2 | **Blocker** | `killProcessTree` on Windows only kills the shell, orphaning the CLI on timeout/unload | `LlmInvoker.ts:68-78` |
| B3 | **Blocker** | Tome port-file auto-detect path is `~/Library/Application Support/Tome/api-port` — macOS-only, so API auto-detection never works on Windows (manual Base URL is the only workaround) | `constants.ts:13`, consumed at `RecordingApi.ts:24-35` |
| B4 | **Blocker** | Export bundle shells out to `/usr/bin/zip` — absent on Windows, export fails | `MeetingExporter.ts:120` |
| P1 | Parity | System-prompt injection (`--append-system-prompt "$(cat …)"`) is POSIX-gated — Windows loses prompt-cache optimization and system-prompt authority | `LlmInvoker.ts:198-200, 233-255` |
| P2 | Parity | Debug terminal mode is Terminal.app/AppleScript-only; settings toggle hidden off-macOS | `LlmInvoker.ts:373-443`, `settings.ts:1038` |
| P3 | Parity | `microphoneUser` autofill uses macOS `id -F`; skipped on Windows | `main.ts:504-518` |
| H1 | Hardening | Filename sanitizer strips illegal chars but not Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) or trailing dots/spaces | `src/utils/sanitize.ts:1-10` |
| H2 | Hardening | Post-transcription rename of audio + sidecar can hit Windows file locking if Tome still holds the file | `ApiUnlinkedProvider.ts:184-231` |
| H3 | Hardening | `~/` expansion in prompt paths doesn't accept `~\` (minor; `~/` itself already works via `path.join(homedir(), …)`) | `LlmInvoker.ts:144-148` |
| D1 | Docs/UI | macOS-only wording: CLAUDE.md ("runs only on macOS"), manifest description ("MacWhisper transcript linking"), settings desc "Cmd+Opt+I" | `CLAUDE.md`, `manifest.json`, `settings.ts:1051` |

---

## 2. Design decisions

### D-1: Windows LLM spawn strategy — PowerShell, not cmd.exe

The current Windows branch (`LlmInvoker.ts:296-301`) spawns the whole command string with `shell: true` (cmd.exe). cmd.exe has no heredocs and no command substitution, which is why B1 and P1 exist. Switching the Windows spawn to **PowerShell** solves both with one mechanism:

- Trigger delivery: `Get-Content -Raw -LiteralPath '<triggerFile>' | & '<cli>' <flags>` — pipes stdin without heredocs, and works for `.exe`, `.cmd`, and `.ps1` CLI shims alike (the `&` call operator resolves PATH the way users expect for npm-installed CLIs like `claude.cmd`).
- System-prompt injection: `--append-system-prompt "$(Get-Content -Raw -LiteralPath '<sysFile>')"` — PowerShell's `$( )` subexpression is the direct analog of the POSIX `$(cat …)`, giving Windows the same prompt-cache behavior (P1).
- Quoting: single-quoted PowerShell literals with `''` doubling — add a `psQuote()` helper mirroring `shellQuote()`.

Rejected alternatives:

- *cmd.exe with `< triggerFile` redirect*: fixes B1 minimally but leaves P1 unsolved (no command substitution in cmd), so Windows permanently loses prompt caching. Keep this in your back pocket only if PowerShell native-argument quoting proves unworkable (see Risks).
- *Direct spawn of the CLI with an args array (no shell)*: cleanest in theory, but npm-installed CLIs on Windows are `.cmd` shims which Node cannot spawn without a shell, and routing through `cmd /c` mangles argv containing quotes/newlines. Not robust for arbitrary user-configured CLIs.

**Known risk:** Windows PowerShell 5.1's native-command argument passing re-quotes arguments and can mangle embedded double quotes in the expanded system-prompt content. Mitigation is built into the design: prompt content is passed via `$(Get-Content -Raw …)` *inside the PowerShell command string* (PowerShell does the expansion and hands one argument to the native process), which is the same trust boundary as the existing POSIX `$(cat …)`. Test with a prompt file containing `"` , `'`, backticks, `$`, and newlines (Phase 6). If PS 5.1 proves unreliable for pathological content, fall back to user-message delivery for that run (the code already has this fallback path — `content === undefined` branch).

### D-2: Kill trees on Windows with `taskkill /T`

`taskkill /PID <pid> /T` (graceful, WM_CLOSE) then `/T /F` (force) maps onto the existing SIGTERM → 5s → SIGKILL escalation in `spawnLlmPrompt` (`LlmInvoker.ts:333-342`). Console CLIs often ignore the graceful close; that's fine — the existing 5-second force-kill escalation covers it.

### D-3: Tome port file at `%APPDATA%\Tome\api-port`

Windows convention for the macOS `~/Library/Application Support/Tome/api-port`. Resolve as `path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Tome", "api-port")`.

> **Coordination required:** this is a contract with the Tome Windows port. Confirm Tome-on-Windows writes its port file to `%APPDATA%\Tome\api-port` (Roaming, not Local). If Tome chooses `%LOCALAPPDATA%`, mirror that here instead. The manual Base URL setting (`settings.ts:693-702`) remains the escape hatch either way.

### D-4: Replace `/usr/bin/zip` with bundled `fflate` on both platforms

A pure-JS zip (fflate, ~8 KB, zero deps, sync API) removes the external-binary dependency entirely and deletes a platform branch instead of adding one. esbuild bundles it into `main.js` as usual.

Rejected alternative: Windows `tar.exe -a -c -f` (bsdtar, ships with Win10 1803+) — works, but keeps a per-platform branch and an external-tool dependency for no benefit.

### D-5: Windows debug terminal via `wt.exe` with `start powershell` fallback

Parity for P2: write the same temp trigger/system-prompt files, generate a `.ps1` runner script instead of `.sh`, and launch it in a visible window: prefer Windows Terminal (`wt.exe`) when on PATH, else `cmd /c start "" powershell -NoProfile -NoExit -File <script>`. Un-hide the settings toggle on Windows.

### D-6: `microphoneUser` autofill via .NET `UserPrincipal.DisplayName`

`powershell -NoProfile -Command "Add-Type -AssemblyName System.DirectoryServices.AccountManagement; [System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName"` — works for both local and domain accounts. The existing 3-second timeout and silent-empty fallback (`main.ts:506-517`) carry over unchanged.

---

## 3. Phased execution plan

### Phase 1 — LLM invocation on Windows (B1, B2, P1) — the critical path

All changes in `src/services/LlmInvoker.ts`.

**1a. Add PowerShell quoting helper** (next to `shellQuote`, ~line 86):

```ts
/** Quote a string as a PowerShell single-quoted literal ('' escapes '). */
function psQuote(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}
```

**1b. Make `buildLlmCommand` platform-aware.** Today it unconditionally emits a bash heredoc (`LlmInvoker.ts:260`) and gates system-prompt temp-file creation on `!Platform.isWin` (`:233`). Restructure:

- Remove the `!Platform.isWin` gate at `:233` — create the system-prompt temp file on all platforms (the mechanism — read prompt file, write to vault-local tmp — is already cross-platform).
- Write the **trigger to a temp file too when on Windows** (same `getPluginTmpDir` + `wcal-trigger-*.txt` pattern the terminal path already uses at `:404-406`), pushed onto `tmpFiles` so existing cleanup handles it.
- Build the command per platform:

```ts
// POSIX (unchanged):
//   <cli> <flags> --append-system-prompt "$(cat '<sys>')" <<'__WCAL_EOF__' … __WCAL_EOF__
// Windows (new, PowerShell syntax):
//   Get-Content -Raw -LiteralPath '<trigger>' | & '<cli>' <flags> --append-system-prompt "$(Get-Content -Raw -LiteralPath '<sys>')"
```

Concretely, in `buildCliCommand` (`:185-208`) the `systemPromptFile` flag becomes:

```ts
if (systemPromptFile) {
	flagParts.push(
		Platform.isWin
			? `--append-system-prompt "$(Get-Content -Raw -LiteralPath ${psQuote(systemPromptFile)})"`
			: `--append-system-prompt "$(cat ${shellQuote(systemPromptFile)})"`,
	);
}
```

and the CLI token itself becomes `& ${psQuote(opts.llmCli)}` on Windows (the `&` call operator is required to invoke a quoted command name). Audit `platformQuote()` (`:102-108`): its Windows branch is cmd.exe-style (`""` doubling in double quotes). Since the Windows shell is now PowerShell, **change the Windows branch of `platformQuote` to `psQuote`** — check all three call sites (`appendFlags`, `--model`, CLI name) still compose correctly.

**1c. Spawn via PowerShell** (`:296-301`):

```ts
child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
	cwd: vaultPath,
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});
```

(Keep the POSIX branch byte-for-byte unchanged — do not risk the working macOS path.)

**1d. Fix `killProcessTree`** (`:68-78`):

```ts
export function killProcessTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
	if (Platform.isWin && child.pid) {
		const args = signal === "SIGKILL"
			? ["/PID", String(child.pid), "/T", "/F"]
			: ["/PID", String(child.pid), "/T"];
		execFile("taskkill", args, {timeout: 5000}, () => { /* best-effort */ });
		return;
	}
	if (child.pid) {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch { /* group gone — fall through */ }
	}
	child.kill(signal);
}
```

Note the existing escalation logic (`:333-342`) checks `child.killed` before force-killing; `taskkill` doesn't set `child.killed`, so the force-kill timer will always fire on Windows — harmless (taskkill on a dead PID just errors, which is swallowed), but add a comment so nobody "fixes" it.

**1e. `validateLlmCli` stays where.exe-based** — but note `where.exe` won't find PowerShell-profile aliases. Acceptable; document in README/settings desc that the CLI must be on PATH.

**Acceptance criteria:**
- On Windows: speaker tagging, summarize, and research all complete end-to-end with a real CLI.
- Debug logging shows a PowerShell pipeline command, and the LLM's answer proves the system prompt was received (P1 parity) — verify with a prompt file containing double quotes, `$`, backticks, and newlines.
- Setting a 1-minute timeout on a long job kills the *CLI process* (verify in Task Manager: no orphaned node/claude process), not just powershell.exe.
- macOS behavior is bit-identical (no diff in the generated command on macOS).

### Phase 2 — Tome port-file discovery + rename hardening (B3, H2)

**2a. `src/constants.ts:13`** — platform-select the port file:

```ts
import {homedir} from "os";
import {join} from "path";

function tomeDataDir(): string {
	if (process.platform === "win32") {
		return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Tome");
	}
	return join(homedir(), "Library", "Application Support", "Tome");
}
export const RECORDING_API_PORT_FILE = join(tomeDataDir(), "api-port");
```

(`constants.ts` has no Obsidian imports today; use `process.platform` rather than pulling in `Platform` — or move the helper into `RecordingApi.ts` which already imports from constants. Either is fine; keep constants dependency-light.)

**2b. Rename retry for locked files** — `ApiUnlinkedProvider.ts` renames the transcript's sibling `.m4a` (`renameAudio`, `:184-194`) and `.voiceprints.json` (`renameSidecar`, `:202-231`) right after transcription completes; on Windows, if Tome still holds a handle, the rename throws (`EBUSY`/`EPERM`). Both methods are already best-effort (errors caught and logged, never thrown — verified), so failure semantics need no change. The work: wrap the `renameFile`/`adapter.rename` calls *inside* those two methods with a small retry helper — 3 attempts, 500 ms apart — before falling into the existing catch/log. A transient Tome handle then heals instead of permanently leaving a mismatched audio/sidecar basename.

**Acceptance criteria:**
- With Tome-for-Windows running and no Base URL configured, "Test API" (`settings.ts:704`) succeeds via port-file auto-detect.
- With a file handle deliberately held open on the `.m4a` (e.g. `powershell -c "$f=[IO.File]::Open('x.m4a','Open','Read','None'); Start-Sleep 60"`), linking still completes and the plugin doesn't error out.

### Phase 3 — Export bundle zip (B4)

`src/services/MeetingExporter.ts`:

- `npm install fflate` (runtime dep; esbuild bundles it).
- Replace the `execFileAsync("/usr/bin/zip", …)` call (`:120-122`) with `fflate`'s `zipSync`: read each staged file with `fs.readFile`, build `{ [ `${noteFile.basename}/${f.name}` ]: data }`, write the result to `zipPath`. This preserves the "one tidy, named directory" extraction layout. Remove the now-unused `child_process`/`promisify` imports.
- Delete the "zip appends to an existing archive" workaround comment/`fs.rm` if writing fresh bytes (a plain overwrite write makes it moot — keep `fs.rm(zipPath, {force: true})` semantics via `writeFile` truncation).
- The staging copy step (`:109-114`) can stay (harmless) or be simplified to read directly from the vault — implementer's choice; staying closer to current code is lower-risk.

**Acceptance criteria:** export on both macOS and Windows produces a zip that extracts to `<Meeting name>/` with note + transcript + audio; opens in Finder/Explorer via the existing reveal; wiki links resolve after extraction.

### Phase 4 — Parity features (P2, P3)

**4a. Windows debug terminal mode.** In `spawnLlmPromptTerminal` (`LlmInvoker.ts:373-443`):

- Change the gate at `:374` from `!Platform.isMacOS` → `!Platform.isMacOS && !Platform.isWin` (message: "Debug terminal mode is only available on macOS and Windows").
- Keep the temp trigger/system-prompt file creation (already platform-neutral).
- On Windows, generate a `.ps1` instead of `.sh`:

```
Set-Location -LiteralPath '<vaultPath>'
Get-Content -Raw -LiteralPath '<trigger>' | & '<cli>' <flags>
Remove-Item -LiteralPath '<tmp1>','<tmp2>',… -ErrorAction SilentlyContinue
```

- Launch: try `wt.exe powershell -NoProfile -NoExit -ExecutionPolicy Bypass -File <script>` first (Windows Terminal, nicer); on spawn error fall back to `cmd /c start "" powershell -NoProfile -NoExit -ExecutionPolicy Bypass -File <script>`. `-NoExit` keeps the window open so the user can read output — mirroring Terminal.app behavior.
- `settings.ts:1038`: change `if (Platform.isMacOS)` → `if (Platform.isMacOS || Platform.isWin)` and update the desc to "Terminal window" (already generic).

**4b. `microphoneUser` autofill.** `main.ts:504-518`: extend to Windows:

```ts
if (!this.settings.microphoneUser) {
	let fullName = "";
	if (Platform.isMacOS) {
		fullName = await execFullName("id", ["-F"]);
	} else if (Platform.isWin) {
		fullName = await execFullName("powershell.exe", ["-NoProfile", "-Command",
			"Add-Type -AssemblyName System.DirectoryServices.AccountManagement; [System.DirectoryServices.AccountManagement.UserPrincipal]::Current.DisplayName"]);
	}
	if (fullName) { this.settings.microphoneUser = fullName; await this.persistData(); }
}
```

(Factor the existing promise wrapper into a small helper; keep the 3 s timeout — bump to 5 s for the Windows branch, domain lookups can be slow — and the silent-empty fallback.)

**Acceptance criteria:** debug mode opens a visible PowerShell/WT window that runs the CLI and stays open; fresh install on Windows pre-fills Microphone user with the account display name (or leaves it empty without erroring, e.g. on a Microsoft-account machine with no display name).

### Phase 5 — Hardening & polish (H1, H3, D1)

**5a. `src/utils/sanitize.ts`** — extend `sanitizeFilename`:

```ts
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilename(name: string): string {
	let sanitized = name.replace(ILLEGAL_FILENAME_CHARS, "").trim();
	sanitized = sanitized.replace(/[. ]+$/, "");        // Windows: no trailing dots/spaces
	if (WINDOWS_RESERVED.test(sanitized)) sanitized = `${sanitized}-note`;
	return sanitized || "untitled";
}
```

Apply on all platforms (a vault synced from macOS to a Windows machine hits the same constraint).

**5b. `LlmInvoker.ts:146`** — accept both separators: `if (promptPath.startsWith("~/") || promptPath.startsWith("~\\"))`.

**5c. Docs & strings:**
- `CLAUDE.md`: rewrite "runs only on macOS desktop (uses Node APIs and AppleScript)" → desktop-only, macOS + Windows; note the MacWhisper source and its command remain macOS-only; add Windows deploy path note (`<vault>\.obsidian\plugins\whisper-cal\`).
- `manifest.json` description: genericize "MacWhisper transcript linking" → "recording transcript linking" (keep `isDesktopOnly: true` — the plugin uses Node/Electron throughout; that flag is about desktop-vs-mobile, not OS).
- `settings.ts:1051` debug-logging desc: "Cmd+Opt+I" → platform-aware ("Cmd+Opt+I / Ctrl+Shift+I").
- `AGENTS.md` install path note if touched.

**Acceptance criteria:** `npm run lint` passes (watch the `obsidianmd/ui/sentence-case` rule on edited UI strings); a meeting titled `CON` or ending in `.` creates a valid note on Windows.

### Phase 6 — Verification (no code)

Build: `npm run build` on a Windows machine; deploy `main.js`, `manifest.json`, `styles.css` to a test vault; reload Obsidian.

Full manual matrix on Windows:

| # | Test | Pass condition |
|---|---|---|
| 1 | MS 365 + Google OAuth sign-in | Loopback redirect completes; calendar renders |
| 2 | Note creation from event (template) | Note created, frontmatter correct |
| 3 | Recording API auto-detect (no Base URL, Tome running) | Test API succeeds via `%APPDATA%\Tome\api-port` |
| 4 | Live record start/stop from MeetingCard; automation on join-link + app close | Tome starts/stops; Teams/Zoom process terminated on stop |
| 5 | Transcript folder scan → link → renames (transcript, `.m4a`, `.voiceprints.json`) | All three renamed to note basename; retry survives a briefly-held lock |
| 6 | Voiceprint match (known speaker) + enrollment (new speaker) | CERTAIN pre-fill in SpeakerTagModal; library updated |
| 7 | Speaker tagging via LLM fallback; summarize; research | All complete; output applied; system prompt honored (test prompt containing `"`, `$`, backtick, newlines) |
| 8 | LLM timeout + plugin unload mid-job | No orphaned CLI processes in Task Manager |
| 9 | Debug terminal mode | Visible window, CLI runs, window persists |
| 10 | Export bundle | Zip in chosen folder, Explorer reveal, extracts to named dir |
| 11 | Meeting titled `CON`, `Q4: "Review"?`, trailing `...` | Valid filenames, no errors |
| 12 | Settings UI | No MacWhisper option in Source; debug-mode toggle visible; Base URL flow works |
| 13 | Regression on macOS | Full smoke of the same list on the primary vault (`~/SDA`); generated LLM command unchanged |

---

## 4. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| PS 5.1 native-arg quoting mangles system-prompt content with embedded quotes | Medium | Tested explicitly (Phase 6 #7); per-run fallback to user-message delivery already exists in code; worst case, gate injection to PowerShell 7 (`pwsh.exe` if on PATH) or drop to trigger-file-reference mode |
| Command-line length limits (~32 K) with very large prompt files | Low | System prompt travels via `$(Get-Content …)` expansion inside PowerShell — expansion happens in PS's argument, still subject to CreateProcess limits; if a prompt file > ~25 KB is plausible, fall back to user-message delivery above a size threshold |
| Tome-for-Windows port-file location mismatch | Medium | Explicit coordination note (D-3); manual Base URL always works |
| `taskkill` graceful close ignored by console CLIs | High (expected) | Existing 5 s force-kill escalation handles it |
| Windows Defender/SmartScreen interference with spawned CLI | Low | User-installed CLI; document that first run may prompt |
| npm `.cmd` shim CLIs | Medium | Solved by design — PowerShell `&` operator resolves `.cmd` fine (this is why we're not doing direct no-shell spawn) |
| macOS regression from shared-code edits | Medium | POSIX spawn branch kept byte-identical; Phase 6 #13 regression pass |

## 5. Out of scope

- Linux support (explicitly deferred).
- Porting the MacWhisper SQLite source or its command to Windows (app doesn't exist there).
- Tome's own Windows port (separate project; only the port-file path contract touches this plan).
- Automated tests (repo has none; the manual matrix above is the verification story).

## 6. Suggested execution order & sizing

| Phase | Size | Depends on |
|---|---|---|
| 1 — LLM invocation | L (the careful one) | — |
| 2 — Port file + rename retry | S | — |
| 3 — fflate export | S | — |
| 4 — Debug terminal + autofill | M | Phase 1 (reuses psQuote/PS patterns) |
| 5 — Hardening/docs | S | — |
| 6 — Verification | M | 1-5 |

Phases 2, 3, and 5 are independent of Phase 1 and can be done in any order or in parallel.
