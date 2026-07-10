/**
 * Make a click-only element keyboard-operable: focusable (tabindex=0), announced
 * as a button (role, unless one is already set), and activated by Enter/Space —
 * which fire the element's existing click handler. Use on non-native interactive
 * elements (divs, hrefless <a>) so keyboard and screen-reader users can reach
 * them. Attach AFTER the click handler is wired.
 */
export function addActivateOnKey(el: HTMLElement, role = "button"): void {
	el.setAttribute("tabindex", "0");
	if (!el.hasAttribute("role")) el.setAttribute("role", role);
	el.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			el.click();
		}
	});
}
