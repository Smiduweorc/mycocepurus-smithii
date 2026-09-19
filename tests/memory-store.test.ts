import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryStore } from "../index.js";
import type { Claim } from "../index.js";
import { clock } from "./clock.js";
import { refusal } from "./refusal.js";

function claim(fingerprint = "f", claimedAt = 0): Claim {
	return { state: "in-flight", fingerprint, claimedAt, leaseFor: 100 };
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
	const done = {
		state: "complete" as const,
		fingerprint: "f",
		value: "v",
		storedAt: time.now(),
		retainFor: 500,
	};

	await store.complete("k", done);
	time.advance(500);
	assert.deepEqual(await store.claim("k", claim()), done);
	time.advance(1);
	assert.equal(await store.claim("k", claim()), "claimed");
});

test("release drops whatever is held", async () => {
	const store = new MemoryStore<string>({ maxEntries: 4 });

	await store.claim("k", claim());
	await store.release("k");

	assert.equal(store.size, 0);
	assert.equal(await store.claim("k", claim()), "claimed");
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
