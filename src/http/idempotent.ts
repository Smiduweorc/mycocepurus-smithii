import { MycocepurusError } from "../errors.js";
import type { Ledger } from "../ledger.js";
import { fingerprintRequest } from "./fingerprint.js";
import { readKey } from "./key.js";
import { fromStored, toStored, type StoredResponse } from "./stored.js";

/** Whatever answers a `Request` with a `Response`. `fetch` is one. */
export type Handler = (request: Request) => Promise<Response>;

export interface IdempotentOptions {
	/**
	 * Whose request this is: a user id, an API key id, a tenant. Required,
	 * because keys from two clients must never meet, and only your auth layer
	 * knows which client this is.
	 */
	scope: (request: Request) => string | Promise<string>;
	/**
	 * The response for a refusal. {@link statusFor} gives the draft's status;
	 * the body, content type and any documentation link are your API's.
	 */
	refuse: (error: MycocepurusError, request: Request) => Response | Promise<Response>;
	/** Replaces {@link fingerprintRequest} when your notion of "the same request" differs. */
	fingerprint?: (request: Request) => string | Promise<string>;
}

/**
 * Wrap a handler so that a request carrying a key it has seen gets the
 * response it got the first time, byte for byte, and a request carrying a
 * key that is busy or was used for something else gets a refusal.
 *
 * Wrap only the operations that require the header: a request without one
 * is refused as `missing-key`, and the draft has no opinion on which
 * operations those are. A handler that throws has the key released and the
 * error propagated unchanged.
 *
 * The handler's response is read in full before it is answered, because the
 * bytes are what get stored. A streaming response is delivered only once the
 * stream has ended.
 */
export function idempotent(
	ledger: Ledger<StoredResponse>,
	handler: Handler,
	options: IdempotentOptions
): Handler {
	const fingerprint = options.fingerprint ?? fingerprintRequest;

	return async (request: Request): Promise<Response> => {
		// Only a refusal raised before the handler ran is ours to answer. A
		// handler that throws one of our errors is reporting its own problem.
		let ran = false;
		try {
			const key = readKey(request.headers);
			const [scope, print] = await Promise.all([
				options.scope(request),
				fingerprint(request),
			]);
			const outcome = await ledger.run({ scope, key, fingerprint: print }, () => {
				ran = true;
				return handler(request).then(toStored);
			});
			return fromStored(outcome.value);
		} catch (error) {
			if (!ran && error instanceof MycocepurusError) {
				return await options.refuse(error, request);
			}
			throw error;
		}
	};
}
