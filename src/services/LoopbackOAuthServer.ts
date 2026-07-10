import {createServer, type Server} from "http";

const LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SIGN_IN_COMPLETE_HTML =
	"<html><body><h2>Sign-in complete</h2><p>You can close this tab and return to Obsidian.</p></body></html>";

export interface LoopbackStartResult {
	/** Random port the server is listening on (loopback address). */
	port: number;
	/**
	 * Resolves with the OAuth authorization code on success, or `null` if the
	 * user cancelled, the timeout fired, or the redirect carried an error.
	 */
	code: Promise<string | null>;
}

/**
 * Loopback HTTP server that captures the OAuth redirect for Authorization Code
 * + PKCE flows. Shared between Microsoft and Google sign-in.
 *
 * The caller passes the `state` parameter it embedded in the auth URL; the
 * server validates the redirect's `state` matches before resolving the code.
 *
 * Lifecycle: call `start()` once per sign-in attempt, then `stop()` in a
 * `finally` block (or via the auth class's `cancelSignIn`). Calling `stop()`
 * multiple times is safe.
 */
export class LoopbackOAuthServer {
	private server: Server | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private _timedOut = false;
	/** Resolver for the in-flight code promise; nulled once settled. */
	private resolveCode: ((code: string | null) => void) | null = null;

	/** True if the most recent `start()` resolved its code as `null` due to timeout. */
	get timedOut(): boolean {
		return this._timedOut;
	}

	/** Total timeout window in milliseconds (used by callers for user-facing messages). */
	static readonly TIMEOUT_MS = LOOPBACK_TIMEOUT_MS;

	/** Resolve the pending code promise exactly once. */
	private settle(code: string | null): void {
		const resolve = this.resolveCode;
		if (!resolve) return;
		this.resolveCode = null;
		resolve(code);
	}

	start(expectedState: string): Promise<LoopbackStartResult> {
		this._timedOut = false;
		return new Promise((resolveStart, rejectStart) => {
			const codePromise = new Promise<string | null>((r) => { this.resolveCode = r; });

			const server = createServer((req, res) => {
				const url = new URL(req.url ?? "", "http://127.0.0.1");
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				const state = url.searchParams.get("state");

				if (state !== expectedState) {
					res.writeHead(400, {"Content-Type": "text/plain"});
					res.end("Sign-in failed: invalid state parameter");
					return;
				}

				if (code) {
					res.writeHead(200, {"Content-Type": "text/html"});
					res.end(SIGN_IN_COMPLETE_HTML);
					this.settle(code);
				} else {
					const msg = error ?? "No authorization code received.";
					res.writeHead(400, {"Content-Type": "text/plain"});
					res.end(`Sign-in failed: ${msg}`);
					this.settle(null);
				}
			});

			server.on("error", (e) => rejectStart(e));

			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					rejectStart(new Error("Failed to start loopback server"));
					return;
				}
				this.server = server;
				this.timer = setTimeout(() => {
					this._timedOut = true;
					this.settle(null);
					this.stop();
				}, LOOPBACK_TIMEOUT_MS);
				resolveStart({port: addr.port, code: codePromise});
			});
		});
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.server) {
			this.server.close();
			this.server = null;
		}
		// Unblock any caller awaiting the code (e.g. the user cancelled sign-in)
		// so the flow ends immediately instead of hanging until the timeout.
		this.settle(null);
	}
}
