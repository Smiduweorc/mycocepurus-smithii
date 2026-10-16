import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryStore } from "../index.js";
import type { Claim, Completion } from "../index.js";
import { clock } from "./clock.js";
import { refusal } from "./refusal.js";

function claim(fingerprint = "f", owner = "o"): Claim {
	return { state: "in-flight", fingerprint, claimedAt: 0, leaseFor: 100, owner };
}

function done(value = "v"): Completion<string> {
	return { state: "complete", fingerprint: "f", value, storedAt: 0, retainFor: 500 };
}

test("maxEntries must be a positive integer", () => {
	assert.throws(() => new MemoryStore({ maxEntries: 0 }), refusal("invalid-options"));
	assert.throws(() => new MemoryStore({ maxEntries: 1.5 }), refusal("invalid-options"));
});

test("two claims issued in the same tick see exactly one 'claimed'", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	const results = await Promise.all([
		store.claim("k", claim("a")),
		store.claim("k", claim("b")),
	]);

	assert.deepEqual(results, ["claimed", claim("a")]);
});

test("a claim past its lease is absent, so the next claim wins", async () => {
	const time = clock();
	const store = new MemoryStore<string>({ maxEntries: 4, now: time.now });

	assert.equal(await store.claim("k", claim()), "claimed");
	time.advance(101);
	assert.equal(await store.claim("k", claim("later")), "claimed");
});

test("a completion is handed back until its retention passes", async () => {
	const time = clock();
	const store = new MemoryStore<string>({ maxEntries: 4, now: time.now });

	await store.claim("k", claim("f", "a"));
	await store.complete("k", done(), "a");
	time.advance(500);
	assert.deepEqual(await store.claim("k", claim()), done());
	time.advance(1);
	assert.equal(await store.claim("k", claim()), "claimed");
});

test("release drops the claim held by the same owner", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	await store.claim("k", claim("f", "a"));

	assert.equal(await store.release("k", "a"), true);
	assert.equal(store.size, 0);
	assert.equal(await store.claim("k", claim()), "claimed");
});

test("release by another owner leaves the claim in place", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	await store.claim("k", claim("f", "b"));

	assert.equal(await store.release("k", "a"), false);
	assert.deepEqual(await store.claim("k", claim("g", "c")), claim("f", "b"));
});

test("release of a completion or of nothing does nothing", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	assert.equal(await store.release("k", "a"), false);
	await store.claim("k", claim("f", "a"));
	await store.complete("k", done(), "a");

	assert.equal(await store.release("k", "a"), false);
	assert.deepEqual(await store.claim("k", claim()), done());
});

test("release of an owner's claim past its lease does nothing", async () => {
	const time = clock();
	const store = new MemoryStore<string>({ maxEntries: 4, now: time.now });

	await store.claim("k", claim("f", "a"));
	time.advance(101);

	assert.equal(await store.release("k", "a"), false);
});

test("complete replaces the claim held by the same owner", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	await store.claim("k", claim("f", "a"));

	assert.equal(await store.complete("k", done(), "a"), true);
	assert.deepEqual(await store.claim("k", claim()), done());
});

test("complete by another owner leaves that owner's claim in place", async () => {
	const time = clock();
	const store = new MemoryStore<string>({ maxEntries: 4, now: time.now });

	await store.claim("k", claim("f", "a"));
	time.advance(101);
	await store.claim("k", claim("f", "b"));

	assert.equal(await store.complete("k", done(), "a"), false);
	assert.deepEqual(await store.claim("k", claim()), claim("f", "b"));
});

test("complete with no claim, an expired claim, or over a completion writes nothing", async () => {
	const time = clock();
	const store = new MemoryStore<string>({ maxEntries: 4, now: time.now });

	assert.equal(await store.complete("k", done(), "a"), false);
	assert.equal(store.size, 0);

	await store.claim("k", claim("f", "a"));
	time.advance(101);
	assert.equal(await store.complete("k", done(), "a"), false);
	assert.equal(store.size, 0);

	await store.claim("k", claim("f", "b"));
	await store.complete("k", done("first"), "b");
	assert.equal(await store.complete("k", done("second"), "b"), false);
	assert.deepEqual(await store.claim("k", claim()), done("first"));
});

test("forget drops whatever is held, whoever holds it", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	await store.claim("a", claim("f", "x"));
	await store.claim("b", claim("f", "y"));
	await store.complete("b", done(), "y");
	await store.forget("a");
	await store.forget("b");
	await store.forget("missing");

	assert.equal(store.size, 0);
});

test("the least recently used entry is evicted past maxEntries", async () => {
	const store = new MemoryStore<string>({ maxEntries: 2 });

	await store.claim("a", claim());
	await store.claim("b", claim());
	await store.claim("a", claim()); // touches a
	await store.claim("c", claim());

	assert.equal(store.size, 2);
	assert.notEqual(await store.claim("a", claim("again")), "claimed");
	assert.equal(await store.claim("b", claim("again")), "claimed");
});
