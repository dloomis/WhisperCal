# Calendar Date Picker — Implementation Plan

**Status:** planned, not started
**Estimated scope:** ~60 lines in `src/ui/CalendarView.ts`, ~25 lines in `styles.css`. No new files, no new dependencies, no settings changes.

## Goal

Let the user jump directly to any date from the calendar view header, instead of stepping day-by-day with the chevron buttons, and give them a quick month-grid reference ("what day is the 23rd?").

**Core behavior:** selecting a date in the picker navigates the calendar view to that day — exactly as if the user had chevron-stepped there: the header date updates, that day's events load, and the Today button appears/hides appropriately. This is implemented by the input's `change` handler calling `navigateToDate()` (steps 1–2 below).

**Trigger:** the existing day/date text in the header (`.whisper-cal-date`, e.g. "Monday, July 20") becomes clickable, styled like a hyperlink. Clicking it pops up a calendar picker. **Do not add a new icon button** — an earlier draft of this feature used a calendar icon; that was explicitly rejected in favor of the clickable date.

## Widget choice (decided — do not revisit)

Obsidian's public API has **no** calendar/date-picker component. The underlying platform (Electron/Chromium) does: `<input type="date">` plus `HTMLInputElement.showPicker()`, which opens Chromium's built-in month-grid calendar popup anchored to the input. Use that. Rationale:

- It is the platform-standard widget: month grid, today highlighted, month/year navigation, keyboard support — both value props for free.
- Zero dependencies, no hand-rolled grid to maintain.
- `showPicker()` is supported in Chromium ≥ 99; Obsidian's Electron is far newer. It requires a user gesture — our click handler satisfies that.

The picker anchors to the input element's on-screen position, so the input must be **rendered** (not `display:none`) and positioned where the popup should appear. We overlay an invisible input on the date text.

## Current code (read these before editing)

- `src/ui/CalendarView.ts`
  - `onOpen()` around lines 133–156: builds the header nav row — `prevBtn`, `this.dateEl` (`whisper-cal-date`), `nextBtn`, then `todayBtn`.
  - `navigateDay(offset)` at ~line 1666 and `navigateToToday()` at ~1676: the navigation pattern to replicate — set `this.selectedDate`, reset `this.lastRefreshTime = 0`, call `this.updateHeader()`, `void this.refresh()`.
  - `updateHeader()` at ~1683: rewrites `dateEl.textContent`.
- `src/utils/time.ts`
  - `formatDate(date, timezone)` → `"YYYY-MM-DD"` key in the configured timezone (exported, ~line 162).
  - `midnightFromDateKey(localDate, timezone)` → `Date` at that zone's local midnight (exported, line 38).
- `src/utils/a11y.ts` — `addActivateOnKey(el)`, already used on `todayBtn` (CalendarView.ts:155).
- `styles.css` lines 28–63 — `.whisper-cal-nav`, `.whisper-cal-date`, `.whisper-cal-today-btn` (note the hover-underline pattern on the today button).

## Critical timezone rule

The view formats everything through `this.settings.timezone`, which may differ from the system zone. **Never** convert the input's `"YYYY-MM-DD"` value with `new Date(value)` — that parses as UTC midnight and lands on the wrong calendar day in negative-offset zones. Always:

- to **write** the input value: `formatDate(this.selectedDate, this.settings.timezone)`
- to **read** it back: `midnightFromDateKey(value, this.settings.timezone)`

This mirrors why `navigateDay` uses `addDaysInTimezone` (see the comment at CalendarView.ts:1667).

## Implementation steps

### 1. `CalendarView.ts` — make the date element a picker trigger

In `onOpen()`, replace the current `this.dateEl = nav.createDiv({...})` block (lines 143–146) with a wrapper that holds both the clickable date text and the invisible date input:

```ts
// Date label doubles as the date-picker trigger: an invisible native
// <input type="date"> overlays it so showPicker() anchors the popup here.
const dateWrap = nav.createDiv({cls: "whisper-cal-date-wrap"});
this.dateEl = dateWrap.createDiv({
	cls: "whisper-cal-date whisper-cal-date-clickable",
	text: formatDisplayDate(this.selectedDate, this.settings.timezone),
	attr: {"aria-label": "Pick a date", role: "button", tabindex: "0"},
});
this.datePickerInput = dateWrap.createEl("input", {
	cls: "whisper-cal-date-picker-input",
	attr: {type: "date", "aria-hidden": "true", tabindex: "-1"},
});
this.registerDomEvent(this.dateEl, "click", () => this.openDatePicker());
addActivateOnKey(this.dateEl);
this.registerDomEvent(this.datePickerInput, "change", () => {
	const value = this.datePickerInput?.value;
	if (!value) return; // user cleared the field — keep current day
	this.navigateToDate(midnightFromDateKey(value, this.settings.timezone));
});
```

Notes:
- Add a field near the other element fields (~line 66–75): `private datePickerInput: HTMLInputElement | null = null;`
- `addActivateOnKey` is already imported for `todayBtn` — verify, don't re-import.
- Import `midnightFromDateKey` and (if not already imported) `formatDate` from `../utils/time` — check the existing import list at the top of the file first; several time helpers are already imported.
- Keep the existing `whisper-cal-date` class so current layout CSS still applies; `whisper-cal-date-clickable` adds only the link affordance.
- `dateWrap` must take over the `flex: 1` role that `.whisper-cal-date` currently plays in the nav row (see CSS step) so the `[<] date [>]` layout is unchanged.

### 2. `CalendarView.ts` — new methods

Add next to `navigateDay` / `navigateToToday` (~line 1666):

```ts
private openDatePicker(): void {
	const input = this.datePickerInput;
	if (!input) return;
	// Open on the currently viewed day, not whatever was last picked
	input.value = formatDate(this.selectedDate, this.settings.timezone);
	try {
		input.showPicker();
	} catch {
		// NotAllowedError etc. — showPicker needs a user gesture; nothing to do
	}
}

private navigateToDate(date: Date): void {
	this.selectedDate = date;
	this.lastRefreshTime = 0; // reset debounce
	this.updateHeader();
	void this.refresh();
}
```

Optional tidy-up: `navigateToToday()` can become `this.navigateToDate(new Date())` — do this only if the diff stays trivially equivalent.

### 3. `styles.css` — link affordance + invisible input

Add after the `.whisper-cal-date` block (~line 51):

```css
/* Date text is the date-picker trigger — reads as a link */
.whisper-cal-date-wrap {
	position: relative;
	flex: 1;
	min-width: 0;
}

.whisper-cal-date-wrap .whisper-cal-date {
	flex: unset;
	cursor: pointer;
}

.whisper-cal-date-clickable:hover {
	color: var(--interactive-accent);
	text-decoration: underline;
}

/* Invisible native <input type="date"> overlaying the date text: it must be
   rendered (not display:none) so showPicker() can anchor its popup here,
   but it must never intercept clicks or paint anything. */
.whisper-cal-date-picker-input {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	opacity: 0;
	pointer-events: none;
	border: none;
	padding: 0;
	margin: 0;
}

/* Chromium themes the picker popup from the input's color-scheme —
   follow the active Obsidian theme, not the OS */
.theme-dark .whisper-cal-date-picker-input {
	color-scheme: dark;
}
.theme-light .whisper-cal-date-picker-input {
	color-scheme: light;
}
```

Layout caution: `.whisper-cal-date` currently carries `flex: 1` inside the flex row `.whisper-cal-nav`. The wrapper takes that over (above) and the inner date div gets `flex: unset`. After the change, visually confirm the header row still renders `[<]  Monday, July 20  [>]` with the date centered (`.whisper-cal-date` already has `text-align: center`).

## Constraints & conventions (from CLAUDE.md — follow exactly)

- Imperative DOM only (`createEl`/`createDiv`); no frameworks.
- All new CSS classes prefixed `whisper-cal-`; all CSS goes in `styles.css`, never inline styles / `setCssStyles` for static styling.
- UI strings sentence case (`"Pick a date"` ✓ — eslint `obsidianmd/ui/sentence-case` enforces this).
- Event listeners via `this.registerDomEvent(...)` so the view cleans them up automatically.
- TypeScript strict: `datePickerInput` is nullable — guard before use (the snippets above already do).

## Edge cases the implementation must handle

1. **Timezone drift** — covered by the `formatDate`/`midnightFromDateKey` rule above; no `new Date("YYYY-MM-DD")` anywhere.
2. **Cleared input** — Chromium's picker has a "Clear" affordance; `change` fires with `value === ""`. Guarded: stay on the current day.
3. **Picking the already-selected day** — Chromium doesn't fire `change` when the value is unchanged, so no spurious refresh; if it did, `navigateToDate` is idempotent and merely refreshes.
4. **Today button visibility** — `navigateToDate` calls `updateHeader()`, which already calls `updateTodayButtonVisibility()`; picking today hides the Today button, picking another day shows it. No extra work needed — just verify.
5. **Midnight rollover while picker interaction is pending** — no special handling; `refresh()` already resolves rollover (CalendarView.ts:340-ish).
6. **`showPicker()` throwing** — wrapped in try/catch; the click gesture makes this nearly impossible, but Chromium also throws if the input is disabled or in a cross-origin iframe (neither applies).

## Verification checklist

1. `npm run build` — clean type-check and bundle.
2. `npm run lint` — clean (watch for sentence-case and no-inline-style rules).
3. Deploy to the test vault: copy `main.js`, `manifest.json`, `styles.css` to `~/SDA/.obsidian/plugins/whisper-cal/`, reload Obsidian.
4. Manual tests:
   - Hover the header date → accent color + underline, pointer cursor.
   - Click the date → Chromium calendar popup opens **on the currently viewed month**, today ringed/highlighted.
   - Pick another day → view navigates there, header text updates, Today button appears.
   - Pick today → Today button hidden.
   - Navigate with chevrons afterwards → still steps one day at a time from the picked date.
   - Press Enter with the date text focused (keyboard) → picker opens.
   - Switch Obsidian light ↔ dark theme → picker popup follows the app theme.
   - Chevron/Today behavior unchanged; header layout unchanged.
5. If the user's configured timezone differs from system TZ (settings → timezone), pick a date and confirm the header shows that same calendar date (no off-by-one).

## Out of scope

- Marking days that have meetings/notes inside the picker grid (Chromium's native picker can't be decorated — would require a custom widget; revisit only if requested).
- Week/month calendar views.
- Any settings/toggles for this feature.
