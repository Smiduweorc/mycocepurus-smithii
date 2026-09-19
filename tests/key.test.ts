import assert from "node:assert/strict";
import { test } from "node:test";

import { assertKey } from "../index.js";
import { refusal } from "./refusal.js";

test("printable ASCII within the cap is returned as-is", () => {
	assert.equal(assertKey("abc-123 ~!", 16), "abc-123 ~!");
});

test("exactly the cap is accepted and one over is refused", () => {
	assert.equal(assertKey("a".repeat(8), 8), "a".repeat(8));
	assert.throws(() => assertKey("a".repeat(9), 8), refusal("invalid-key"));
});

test("an empty key is refused", () => {
	assert.throws(() => assertKey("", 8), refusal("invalid-key"));
});

test("a control character, DEL and non-ASCII are refused", () => {
	assert.throws(() => assertKey("a\tb", 8), refusal("invalid-key"));
	assert.throws(() => assertKey("a\x7fb", 8), refusal("invalid-key"));
	assert.throws(() => assertKey("aéb", 8), refusal("invalid-key"));
});

test("a non-string is refused rather than coerced", () => {
	assert.throws(() => assertKey(42 as unknown as string, 8), refusal("invalid-key"));
});
