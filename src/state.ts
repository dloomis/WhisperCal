/** Module-level shared state readable by any component. */

/** Note paths currently being summarized. */
export const summarizeJobs = new Set<string>();

/** Transcript paths currently being speaker-tagged. */
export const speakerTagJobs = new Set<string>();
