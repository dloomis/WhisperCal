# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WhisperCal is an Obsidian community plugin (currently based on the sample plugin template). TypeScript source in `src/` is bundled by esbuild into a single `main.js` loaded by Obsidian. No runtime dependencies — everything compiles into one file.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Watch mode with inline sourcemaps
npm run build        # Type-check (tsc --noEmit) + production esbuild (minified)
npm run lint         # ESLint (flat config with typescript-eslint + obsidian plugin)
npm run version      # Bump version in manifest.json + versions.json (run after npm version patch/minor/major)
```

There are no automated tests. Manual testing: copy `main.js`, `manifest.json`, `styles.css` into a vault's `.obsidian/plugins/<plugin-id>/` and reload Obsidian.

## Architecture

- **`src/main.ts`** — Plugin entry point. Extends `Plugin`, handles `onload`/`onunload`, registers commands, ribbon icons, status bar, settings tab, event listeners, and intervals. Keep this file minimal — delegate feature logic to other modules.
- **`src/settings.ts`** — Exports `MyPluginSettings` interface, `DEFAULT_SETTINGS`, and `SampleSettingTab` class (extends `PluginSettingTab`). Settings persist via `this.loadData()`/`this.saveData()`.
- **`esbuild.config.mjs`** — Bundles `src/main.ts` → `main.js` (CJS format, ES2018 target). Marks `obsidian`, `electron`, CodeMirror, and Lezer as external.
- **`manifest.json`** — Plugin metadata. `id` is stable and must never change after release. `minAppVersion` must stay accurate.
- **`versions.json`** — Maps plugin version → minimum Obsidian version.

## Key Conventions

- **Module format:** ES modules in source (`"type": "module"` in package.json), CJS output for Obsidian.
- **TypeScript strict mode** enabled — `noImplicitAny`, `strictNullChecks`, etc.
- **Tabs for indentation**, size 4, LF line endings (see `.editorconfig`).
- **`isDesktopOnly: false`** — avoid Node/Electron APIs unless you set this to `true`.
- **Cleanup via `this.register*` helpers** — all DOM events, app events, and intervals must use `registerDomEvent`, `registerEvent`, `registerInterval` so they auto-cleanup on unload.
- **Stable command IDs** — never rename once released.
- **No `v` prefix** on version tags for releases.
- **`main.js` is gitignored** — never commit build output.

## AGENTS.md

This repo includes `AGENTS.md` with detailed Obsidian plugin development guidelines covering file organization, security/privacy policies, UX conventions, performance, and common task patterns. Refer to it for Obsidian-specific coding patterns (adding commands, persisting settings, registering listeners, multi-file organization).
