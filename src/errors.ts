/**
 * Why the ledger refused.
 *
 * `missing-key` and `invalid-key` are about the request; `fingerprint-mismatch`
 * and `in-flight` are about the key's history; `invalid-options` is a bad
 * constructor argument or an empty scope, and belongs in your code rather
 * than in a retry.
 */
export type MycocepurusErrorCode =
	| "missing-key"
	| "invalid-key"
	| "fingerprint-mismatch"
	| "in-flight"
	| "invalid-options";

/**
 * Everything this package throws, so a consumer can tell our refusal from
 * their own action's failure without matching on message text. An action that
 * throws has its error rethrown unchanged; only a refusal is one of these.
 *
 * `mycocepurus-smithii/http` maps `code` to the status the draft names.
 */
export class MycocepurusError extends Error {
	override readonly name = "MycocepurusError";
	readonly code: MycocepurusErrorCode;
	/** The key the refusal is about, when there is one. */
	readonly key: string | undefined;

	constructor(code: MycocepurusErrorCode, message: string, key?: string) {
		super(`mycocepurus-smithii: ${message}`);
		this.code = code;
		this.key = key;
	}
}
