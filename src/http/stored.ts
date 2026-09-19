/**
 * What a `Response` becomes in the store. Status, headers as pairs, and the
 * body as bytes, so an out-of-process `Codec` has nothing to guess about. A
 * codec that goes through JSON has to encode `body` itself; `JSON.stringify`
 * turns a `Uint8Array` into an object of indexed numbers.
 */
export interface StoredResponse {
	status: number;
	headers: [string, string][];
	body: Uint8Array;
}

/**
 * Read a response into something a store can hold. The response is cloned,
 * so the one you pass is still sendable.
 */
export async function toStored(response: Response): Promise<StoredResponse> {
	const copy = response.clone();
	return {
		status: copy.status,
		headers: [...copy.headers.entries()],
		body: new Uint8Array(await copy.arrayBuffer()),
	};
}

/** Turn a stored response back into a `Response`. A new object each time. */
export function fromStored(stored: StoredResponse): Response {
	// A 204 or 304 constructed with a body, even an empty one, is a TypeError.
	const body = stored.body.byteLength === 0 ? null : stored.body.slice();
	return new Response(body, { status: stored.status, headers: stored.headers });
}
