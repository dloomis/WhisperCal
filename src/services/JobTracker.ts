/**
 * Tracks in-progress LLM jobs by note/transcript path. Owned by the plugin
 * instance; cleared on plugin unload so a reload starts with a clean slate.
 *
 * Each kind of job is keyed independently:
 *   - `summarize`  — keyed by meeting note path
 *   - `speakerTag` — keyed by transcript path
 *   - `research`   — keyed by meeting note path
 */
export type JobKind = "summarize" | "speakerTag" | "research";

export class JobTracker {
	private readonly jobs: Record<JobKind, Set<string>> = {
		summarize: new Set(),
		speakerTag: new Set(),
		research: new Set(),
	};

	add(kind: JobKind, key: string): void {
		this.jobs[kind].add(key);
	}

	remove(kind: JobKind, key: string): void {
		this.jobs[kind].delete(key);
	}

	has(kind: JobKind, key: string): boolean {
		return this.jobs[kind].has(key);
	}

	/** Drop all tracked jobs. Does not kill underlying processes — caller handles that. */
	clear(): void {
		for (const k of Object.keys(this.jobs) as JobKind[]) {
			this.jobs[k].clear();
		}
	}
}
