/**
 * Online-meeting join-link hosts, shared by the deep-link opener and the
 * note-body join-block stripper so both recognize the same providers.
 *
 * Teams across clouds: commercial (teams.microsoft.com, incl. GCC), personal
 * (teams.live.com), US government GCC High/DoD (gov/dod.teams.microsoft.us),
 * and China 21Vianet (teams.microsoftonline.cn).
 */
export const TEAMS_HOSTS = [
	"teams.microsoft.com",
	"teams.live.com",
	"teams.microsoft.us",
	"teams.microsoftonline.cn",
];

/** Zoom join-link hosts: commercial (zoom.us) and government (zoomgov.com). */
export const ZOOM_HOSTS = ["zoom.us", "zoomgov.com"];

/** True when hostname is the base domain or any subdomain of it. */
export function hostMatches(hostname: string, bases: string[]): boolean {
	return bases.some(base => hostname === base || hostname.endsWith(`.${base}`));
}
