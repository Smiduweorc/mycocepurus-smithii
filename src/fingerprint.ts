const encoder = new TextEncoder();

/**
 * SHA-256 over `parts`, as lowercase hex.
 *
 * Each part is length-prefixed before hashing, so `["ab", "c"]` and
 * `["a", "bc"]` are different fingerprints. Which parts of a request belong
 * in here is yours to say; `mycocepurus-smithii/http` hashes method, target
 * and body, and nothing else.
 *
 * Uses `globalThis.crypto.subtle`, so there is no `node:` import.
 */
export async function fingerprint(
	parts: readonly (string | Uint8Array)[]
): Promise<string> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (const part of parts) {
		const bytes = typeof part === "string" ? encoder.encode(part) : part;
		const prefix = new Uint8Array(4);
		new DataView(prefix.buffer).setUint32(0, bytes.byteLength);
		chunks.push(prefix, bytes);
		total += 4 + bytes.byteLength;
	}

	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}

	const digest = await globalThis.crypto.subtle.digest("SHA-256", joined);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}
