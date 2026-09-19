import assert from "node:assert/strict";
import { test } from "node:test";

import {
	fingerprintRequest,
	fromStored,
	idempotent,
	readKey,
	statusFor,
	toStored,
} from "../http.js";
import type { StoredResponse } from "../http.js";
import { Ledger, MemoryStore, MycocepurusError, storeAnything } from "../index.js";
import { NUMBERS, clock } from "./clock.js";
import { refusal } from "./refusal.js";

function headers(value?: string): Headers {
	return new Headers(value === undefined ? {} : { "Idempotency-Key": value });
}

test("readKey unquotes a Structured Field String", () => {
	assert.equal(readKey(headers("\"abc-123\"")), "abc-123");
	assert.equal(readKey(headers("  \"padded\"  ")), "padded");
});

test("readKey honours the two escapes and refuses any other", () => {
	assert.equal(readKey(headers("\"a\\\"b\\\\c\"")), "a\"b\\c");
	assert.throws(() => readKey(headers("\"a\\nb\"")), refusal("invalid-key"));
	assert.throws(() => readKey(headers("\"trailing\\\"")), refusal("invalid-key"));
});

test("readKey refuses a bare token, an empty string and non-ASCII", () => {
	assert.throws(() => readKey(headers("abc")), refusal("invalid-key"));
	assert.throws(() => readKey(headers("\"\"")), refusal("invalid-key"));
	assert.throws(() => readKey(headers("\"a\"b\"")), refusal("invalid-key"));
	assert.throws(() => readKey(headers("\"clé\"")), refusal("invalid-key"));
});

test("readKey reports an absent header as missing-key", () => {
	assert.throws(() => readKey(headers()), refusal("missing-key"));
});

const post = (body: string, init?: { path?: string; method?: string; headers?: Record<string, string> }): Request =>
	new Request(`https://api.example${init?.path ?? "/payments"}`, {
		method: init?.method ?? "POST",
		headers: init?.headers,
		body,
	});

test("fingerprintRequest is stable across headers and unstable across method, target and body", async () => {
	const base = await fingerprintRequest(post("{\"a\":1}"));

	assert.equal(
		await fingerprintRequest(post("{\"a\":1}", { headers: { "x-trace": "1" } })),
		base
	);
	assert.notEqual(await fingerprintRequest(post("{\"a\":2}")), base);
	assert.notEqual(await fingerprintRequest(post("{\"a\":1}", { method: "PATCH" })), base);
	assert.notEqual(await fingerprintRequest(post("{\"a\":1}", { path: "/payments?x=1" })), base);
});

test("fingerprintRequest leaves the caller's body readable", async () => {
	const request = post("hello");
	await fingerprintRequest(request);
	assert.equal(await request.text(), "hello");
});

test("toStored and fromStored round-trip status, headers and bytes", async () => {
	const original = new Response("payload", {
		status: 201,
		headers: { "content-type": "text/plain", location: "/payments/1" },
	});

	const stored = await toStored(original);
	const replay = fromStored(stored);

	assert.equal(await original.text(), "payload");
	assert.equal(replay.status, 201);
	assert.equal(replay.headers.get("location"), "/payments/1");
	assert.equal(await replay.text(), "payload");
	assert.equal(fromStored(await toStored(new Response(null, { status: 204 }))).body, null);
});

test("statusFor maps refusals to the draft's numbers and rethrows a server bug", () => {
	assert.equal(statusFor(new MycocepurusError("missing-key", "")), 400);
	assert.equal(statusFor(new MycocepurusError("invalid-key", "")), 400);
	assert.equal(statusFor(new MycocepurusError("in-flight", "")), 409);
	assert.equal(statusFor(new MycocepurusError("fingerprint-mismatch", "")), 422);
	assert.throws(
		() => statusFor(new MycocepurusError("invalid-options", "")),
		refusal("invalid-options")
	);
});

function build(handler: (request: Request) => Promise<Response>): {
	send: (request: Request) => Promise<Response>;
	time: ReturnType<typeof clock>;
} {
	const time = clock();
	const ledger = new Ledger<StoredResponse>({
		store: new MemoryStore({ maxEntries: 8, now: time.now }),
		...NUMBERS,
		shouldStore: storeAnything,
		now: time.now,
	});
	const send = idempotent(ledger, handler, {
		scope: (request) => request.headers.get("authorization") ?? "anonymous",
		refuse: (error) =>
			Response.json({ error: error.code }, { status: statusFor(error) }),
	});
	return { send, time };
}

const keyed = (key: string, body = "{\"amount\":5}", user = "alice"): Request =>
	post(body, { headers: { "Idempotency-Key": `"${key}"`, authorization: user } });

test("the first request runs the handler and the retry gets the same response", async () => {
	let calls = 0;
	const { send } = build(async () => {
		calls += 1;
		return Response.json({ id: calls }, { status: 201, headers: { location: `/p/${calls}` } });
	});

	const first = await send(keyed("k1"));
	const retry = await send(keyed("k1"));

	assert.equal(calls, 1);
	assert.equal(first.status, 201);
	assert.equal(retry.status, 201);
	assert.equal(retry.headers.get("location"), "/p/1");
	assert.deepEqual(await retry.json(), { id: 1 });
});

test("a reused key with a different body is a 422 from refuse", async () => {
	const { send } = build(async () => new Response("ok"));

	await send(keyed("k1"));
	const refused = await send(keyed("k1", "{\"amount\":6}"));

	assert.equal(refused.status, 422);
	assert.deepEqual(await refused.json(), { error: "fingerprint-mismatch" });
});

test("a concurrent copy is a 409 while the first is still running", async () => {
	let release = (): void => {};
	const { send } = build(
		() =>
			new Promise<Response>((resolve) => {
				release = (): void => resolve(new Response("ok", { status: 201 }));
			})
	);

	const first = send(keyed("k1"));
	// Let the first request get through readKey and fingerprinting to its claim.
	await new Promise((resolve) => setImmediate(resolve));
	const second = await send(keyed("k1"));
	release();

	assert.equal(second.status, 409);
	assert.equal((await first).status, 201);
});

test("a missing header is a 400 and the handler never runs", async () => {
	let calls = 0;
	const { send } = build(async () => {
		calls += 1;
		return new Response("ok");
	});

	const refused = await send(post("{}"));

	assert.equal(refused.status, 400);
	assert.equal(calls, 0);
});

test("the same key from two clients runs the handler twice", async () => {
	let calls = 0;
	const { send } = build(async () => {
		calls += 1;
		return new Response("ok");
	});

	await send(keyed("k1", undefined, "alice"));
	await send(keyed("k1", undefined, "bob"));

	assert.equal(calls, 2);
});

test("a handler that throws propagates and frees the key", async () => {
	const boom = new Error("boom");
	let calls = 0;
	const { send } = build(async () => {
		calls += 1;
		if (calls === 1) throw boom;
		return new Response("ok");
	});

	await assert.rejects(send(keyed("k1")), (error: unknown) => error === boom);
	assert.equal((await send(keyed("k1"))).status, 200);
});

test("a handler that throws one of our errors is not answered as a refusal", async () => {
	const own = new MycocepurusError("in-flight", "from the handler");
	const { send } = build(async () => {
		throw own;
	});

	await assert.rejects(send(keyed("k1")), (error: unknown) => error === own);
});

test("the replayed response is a fresh object each time", async () => {
	const { send } = build(async () => new Response("body"));

	const a = await send(keyed("k1"));
	const b = await send(keyed("k1"));

	assert.notEqual(a, b);
	assert.equal(await a.text(), "body");
	assert.equal(await b.text(), "body");
});

test("error responses are replayed too, when shouldStore says so", async () => {
	let calls = 0;
	const { send } = build(async () => {
		calls += 1;
		return Response.json({ error: "card declined" }, { status: 402 });
	});

	await send(keyed("k1"));
	const retry = await send(keyed("k1"));

	assert.equal(calls, 1);
	assert.equal(retry.status, 402);
});
