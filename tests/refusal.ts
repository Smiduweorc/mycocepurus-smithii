import assert from "node:assert/strict";

import { MycocepurusError, type MycocepurusErrorCode } from "../index.js";

/**
 * Asserts a refusal is catchable as one of ours and says which one, so a
 * renamed code fails here rather than silently in a consumer's catch block.
 */
export function refusal(code: MycocepurusErrorCode): (error: unknown) => true {
	return (error: unknown) => {
		assert.ok(
			error instanceof MycocepurusError,
			`expected a MycocepurusError, received ${String(error)}`
		);
		assert.equal(error.code, code);
		return true;
	};
}
