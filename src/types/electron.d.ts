/**
 * Minimal ambient typing for Electron's renderer API. Obsidian ships Electron
 * at runtime and esbuild marks "electron" external, but the real electron
 * package (and its types) is not a dependency — declare just what we use.
 */
declare module "electron" {
	export const shell: {
		openExternal(url: string): Promise<void>;
	};
}
