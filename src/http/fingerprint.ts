import { fingerprint } from "../fingerprint.js";

/**
 * The fingerprint `idempotent` uses: method, path and query, and the body
 * bytes. Headers are left out on purpose, because what varies between two
 * honest retries (a trace id, a token that was refreshed) is a property of
 * your clients, and a fingerprint over it would make every retry a mismatch.
 *
 * The request is cloned, so the caller's body is still readable afterwards.
 */
export async function fingerprintRequest(request: Request): Promise<string> {
	const url = new URL(request.url);
	const body = new Uint8Array(await request.clone().arrayBuffer());
	return fingerprint([request.method.toUpperCase(), url.pathname + url.search, body]);
}
