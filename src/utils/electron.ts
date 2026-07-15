export interface RemoteDialog {
	showOpenDialog(opts: {
		title?: string;
		buttonLabel?: string;
		defaultPath?: string;
		filters?: {name: string; extensions: string[]}[];
		properties: string[];
	}): Promise<{canceled: boolean; filePaths: string[]}>;
}

interface RemoteModule {
	dialog?: RemoteDialog;
}

/**
 * Require a module through the window global so esbuild doesn't try to bundle
 * it. Needed only for `@electron/remote` (exposed by Obsidian's desktop
 * runtime but not in esbuild's external list); plain `electron` is external
 * and can be required directly.
 */
export function windowRequire(module: string): unknown {
	const req = (window as unknown as {require?: (m: string) => unknown}).require;
	try {
		return req ? req(module) : undefined;
	} catch {
		return undefined;
	}
}

/** The system file/folder dialogs, or undefined when the remote module isn't reachable. */
export function remoteDialog(): RemoteDialog | undefined {
	return (windowRequire("@electron/remote") as RemoteModule | undefined)?.dialog;
}
