import assert from "node:assert/strict";
import { test } from "node:test";

import { decide } from "../index.js";
import type { Entry } from "../index.js";

const NOW = 5_000;

const claim: Entry<string> = {
	state: "in-flight",
	fingerprint: "f",
	claimedAt: NOW - 50,
	leaseFor: 100,
};

const done: Entry<string> = {
	state: "complete",
	fingerprint: "f",
	value: "v",
	storedAt: NOW - 300,
	retainFor: 1_000,
};

test("nothing held is a first attempt", () => {
	assert.deepEqual(decide(undefined, "f", NOW), { state: "first" });
});

test("a completion with the same fingerprint is replayed, with its age", () => {
	assert.deepEqual(decide(done, "f", NOW), { state: "replay", value: "v", age: 300 });
});

test("a completion with a different fingerprint is a mismatch", () => {
	assert.deepEqual(decide(done, "g", NOW), { state: "mismatch", held: "complete" });
});

test("a live claim with the same fingerprint is in flight", () => {
	assert.deepEqual(decide(claim, "f", NOW), { state: "in-flight", since: NOW - 50 });
});

test("a live claim with a different fingerprint is a mismatch, not in flight", () => {
	assert.deepEqual(decide(claim, "g", NOW), { state: "mismatch", held: "in-flight" });
});

test("a claim past its lease is a first attempt, whatever the fingerprint", () => {
	assert.deepEqual(decide(claim, "f", NOW + 51), { state: "first" });
	assert.deepEqual(decide(claim, "g", NOW + 51), { state: "first" });
});

test("a completion past its retention is a first attempt", () => {
	assert.deepEqual(decide(done, "f", NOW + 701), { state: "first" });
});

test("the window edges are inclusive", () => {
	assert.equal(decide(claim, "f", NOW + 50).state, "in-flight");
	assert.equal(decide(done, "f", NOW + 700).state, "replay");
});

test("a clock that went backwards reads as written this instant", () => {
	assert.deepEqual(decide(done, "f", NOW - 10_000), {
		state: "replay",
		value: "v",
		age: 0,
	});
	assert.equal(decide(claim, "f", NOW - 10_000).state, "in-flight");
});
