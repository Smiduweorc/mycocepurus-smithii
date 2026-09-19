import assert from "node:assert/strict";
import { test } from "node:test";

import { Ledger, MemoryStore, MycocepurusError, storeAnything } from "../index.js";
import type { Claim, Completion, Entry, Event, Store } from "../index.js";
import { NUMBERS, clock } from "./clock.js";
import { refusal } from "./refusal.js";

function build(options?: {
	onEvent?: (event: Event) => void;
	store?: Store<string>;
	shouldStore?: (value: string) => boolean;
	namespace?: string;
}): { ledger: Ledger<string>; time: ReturnType<typeof clock>; store: Store<string> } {
	const time = clock();
	const store =
		options?.store ?? new MemoryStore<string>({ maxEntries: 8, now: time.now });
	const ledger = new Ledger<string>({
		store,
		...NUMBERS,
		shouldStore: options?.shouldStore ?? storeAnything,
		now: time.now,
		onEvent: options?.onEvent,
		namespace: options?.namespace,
	});
	return { ledger, time, store };
}

function counter(value: string): {
	action: () => Promise<string>;
	calls: () => number;
} {
	let calls = 0;
	return {
		action: async () => {
			calls += 1;
			return `${value}-${calls}`;
		},
		calls: () => calls,
	};
}

/** An action that resolves only when the test says so. */
function gate(value: string): { action: () => Promise<string>; open: () => void } {
	let open = (): void => {};
	const settled = new Promise<string>((resolve) => {
		open = (): void => resolve(value);
	});
	return { action: () => settled, open };
}

const req = (key = "k", fingerprint = "f", scope = "user-1"): {
	scope: string;
	key: string;
	fingerprint: string;
} => ({ scope, key, fingerprint });

test("the first run calls the action and reports itself as first", async () => {
	const { ledger } = build();
	const { action, calls } = counter("v");

	const outcome = await ledger.run(req(), action);

	assert.deepEqual(outcome, { value: "v-1", state: "first", age: 0 });
	assert.equal(calls(), 1);
});

test("a retry with the same fingerprint is replayed without calling the action", async () => {
	const { ledger, time } = build();
	const { action, calls } = counter("v");

	await ledger.run(req(), action);
	time.advance(250);
	const outcome = await ledger.run(req(), action);

	assert.deepEqual(outcome, { value: "v-1", state: "replayed", age: 250 });
	assert.equal(calls(), 1);
});

test("a retry with a different fingerprint is refused and the action never runs", async () => {
	const { ledger } = build();
	const { action, calls } = counter("v");

	await ledger.run(req(), action);
	await assert.rejects(
		ledger.run(req("k", "other"), action),
		refusal("fingerprint-mismatch")
	);
	assert.equal(calls(), 1);
});

test("a second copy arriving while the first is in flight is refused", async () => {
	const { ledger } = build();
	const first = gate("v");
	const { action, calls } = counter("w");

	const winner = ledger.run(req(), first.action);
	await assert.rejects(ledger.run(req(), action), refusal("in-flight"));
	assert.equal(calls(), 0);

	first.open();
	assert.deepEqual(await winner, { value: "v", state: "first", age: 0 });
});

test("a different fingerprint against an in-flight claim is a mismatch, not in-flight", async () => {
	const { ledger } = build();
	const first = gate("v");

	const winner = ledger.run(req(), first.action);
	await assert.rejects(
		ledger.run(req("k", "other"), async () => "w"),
		refusal("fingerprint-mismatch")
	);
	first.open();
	await winner;
});

test("an action that throws releases the key and comes back as itself", async () => {
	const { ledger } = build();
	const boom = new Error("boom");
	const { action, calls } = counter("v");

	await assert.rejects(
		ledger.run(req(), async () => {
			throw boom;
		}),
		(error: unknown) => error === boom
	);
	const outcome = await ledger.run(req(), action);

	assert.deepEqual(outcome, { value: "v-1", state: "first", age: 0 });
	assert.equal(calls(), 1);
});

test("shouldStore declining releases the key so the retry runs again", async () => {
	const events: Event[] = [];
	const { ledger } = build({
		shouldStore: (value) => !value.endsWith("-1"),
		onEvent: (event) => events.push(event),
	});
	const { action, calls } = counter("v");

	await ledger.run(req(), action);
	const outcome = await ledger.run(req(), action);

	assert.deepEqual(outcome, { value: "v-2", state: "first", age: 0 });
	assert.equal(calls(), 2);
	assert.ok(events.some((event) => event.type === "skip"));
	assert.ok(events.some((event) => event.type === "store"));
});

test("a claim past its lease lets the retry become the first attempt", async () => {
	const { ledger, time } = build();
	const stuck = gate("never");
	const { action, calls } = counter("v");

	void ledger.run(req(), stuck.action).catch(() => {});
	time.advance(NUMBERS.leaseFor + 1);
	const outcome = await ledger.run(req(), action);

	assert.deepEqual(outcome, { value: "v-1", state: "first", age: 0 });
	assert.equal(calls(), 1);
	stuck.open();
});

test("a completion past its retention lets the key run again", async () => {
	const { ledger, time } = build();
	const { action, calls } = counter("v");

	await ledger.run(req(), action);
	time.advance(NUMBERS.retainFor + 1);
	const outcome = await ledger.run(req(), action);

	assert.equal(outcome.value, "v-2");
	assert.equal(calls(), 2);
});

test("the same key in two scopes is two keys", async () => {
	const { ledger } = build();
	const { action, calls } = counter("v");

	await ledger.run(req("k", "f", "user-1"), action);
	await ledger.run(req("k", "f", "user-2"), action);

	assert.equal(calls(), 2);
});

test("an empty scope is refused before the store is touched", async () => {
	const { ledger } = build();
	await assert.rejects(
		ledger.run(req("k", "f", ""), async () => "v"),
		refusal("invalid-options")
	);
});

test("a key over the cap or outside printable ASCII is refused", async () => {
	const { ledger } = build();
	await assert.rejects(
		ledger.run(req("x".repeat(NUMBERS.maxKeyLength + 1)), async () => "v"),
		refusal("invalid-key")
	);
	await assert.rejects(ledger.run(req("ключ"), async () => "v"), refusal("invalid-key"));
});

test("a store that cannot take the claim has its error rethrown unchanged", async () => {
	const down = new Error("store down");
	const events: Event[] = [];
	const { ledger } = build({
		onEvent: (event) => events.push(event),
		store: {
			claim: async () => {
				throw down;
			},
			complete: async () => {},
			release: async () => {},
		},
	});
	const { action, calls } = counter("v");

	await assert.rejects(ledger.run(req(), action), (error: unknown) => error === down);
	assert.equal(calls(), 0);
	assert.deepEqual(events, [
		{ type: "store-error", key: "user-1:k", operation: "claim", error: down },
	]);
});

test("a store that cannot record the outcome still hands the value back", async () => {
	const down = new Error("store down");
	const events: Event[] = [];
	const { ledger } = build({
		onEvent: (event) => events.push(event),
		store: {
			claim: async () => "claimed",
			complete: async () => {
				throw down;
			},
			release: async () => {},
		},
	});

	const outcome = await ledger.run(req(), async () => "v");

	assert.deepEqual(outcome, { value: "v", state: "first", age: 0 });
	assert.ok(
		events.some(
			(event) => event.type === "store-error" && event.operation === "complete"
		)
	);
});

test("a store that hands back an expired entry is asked once more, then treated as busy", async () => {
	const stale: Entry<string> = {
		state: "in-flight",
		fingerprint: "f",
		claimedAt: 0,
		leaseFor: 1,
	};
	let claims = 0;
	const { ledger } = build({
		store: {
			claim: async () => {
				claims += 1;
				return stale;
			},
			complete: async () => {},
			release: async () => {},
		},
	});

	await assert.rejects(ledger.run(req(), async () => "v"), refusal("in-flight"));
	assert.equal(claims, 2);
});

test("a live completion on the second claim is replayed, not treated as busy", async () => {
	const { time } = build();
	const stale: Entry<string> = {
		state: "in-flight",
		fingerprint: "f",
		claimedAt: 0,
		leaseFor: 1,
	};
	const done: Entry<string> = {
		state: "complete",
		fingerprint: "f",
		value: "from-the-other-replica",
		storedAt: time.now(),
		retainFor: NUMBERS.retainFor,
	};
	const answers = [stale, done];
	const { ledger } = build({
		store: {
			claim: async () => answers.shift() ?? "claimed",
			complete: async () => {},
			release: async () => {},
		},
	});

	const outcome = await ledger.run(req(), async () => "v");

	assert.deepEqual(outcome, { value: "from-the-other-replica", state: "replayed", age: 0 });
	assert.equal(answers.length, 0);
});

test("events for a first run and its replay, in order", async () => {
	const events: Event[] = [];
	const { ledger, time } = build({ onEvent: (event) => events.push(event) });

	await ledger.run(req(), async () => "v");
	time.advance(10);
	await ledger.run(req(), async () => "w");

	assert.deepEqual(events, [
		{ type: "claim", key: "user-1:k" },
		{ type: "store", key: "user-1:k", retainFor: NUMBERS.retainFor },
		{ type: "replay", key: "user-1:k", age: 10 },
	]);
});

test("a refusal is reported as an event with its code", async () => {
	const events: Event[] = [];
	const { ledger } = build({ onEvent: (event) => events.push(event) });

	await ledger.run(req(), async () => "v");
	await ledger.run(req("k", "other"), async () => "w").catch(() => {});

	assert.deepEqual(events.at(-1), {
		type: "refuse",
		key: "user-1:k",
		code: "fingerprint-mismatch",
	});
});

test("a listener that throws does not break the run", async () => {
	const { ledger } = build({
		onEvent: () => {
			throw new Error("listener");
		},
	});
	assert.equal((await ledger.run(req(), async () => "v")).value, "v");
});

test("the namespace is prefixed onto the store key", async () => {
	const seen: string[] = [];
	const store: Store<string> = {
		claim: async (key: string, _entry: Claim) => {
			seen.push(key);
			return "claimed";
		},
		complete: async (_key: string, _entry: Completion<string>) => {},
		release: async () => {},
	};
	const { ledger } = build({ store, namespace: "payments" });

	await ledger.run(req(), async () => "v");

	assert.deepEqual(seen, ["payments:user-1:k"]);
});

test("forget releases the key so it runs again", async () => {
	const { ledger } = build();
	const { action, calls } = counter("v");

	await ledger.run(req(), action);
	await ledger.forget("user-1", "k");
	await ledger.run(req(), action);

	assert.equal(calls(), 2);
});

test("each number must be finite and positive, and shouldStore is required", () => {
	const store = new MemoryStore<string>({ maxEntries: 1 });
	for (const name of ["retainFor", "leaseFor", "maxKeyLength"] as const) {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "10"]) {
			assert.throws(
				() =>
					new Ledger<string>({
						store,
						...NUMBERS,
						shouldStore: storeAnything,
						[name]: bad,
					}),
				refusal("invalid-options"),
				`${name} = ${String(bad)}`
			);
		}
	}
	assert.throws(
		() =>
			new Ledger<string>({
				store,
				...NUMBERS,
				shouldStore: undefined as unknown as () => boolean,
			}),
		refusal("invalid-options")
	);
});

test("refusals are MycocepurusError with the key on them", async () => {
	const { ledger } = build();
	await ledger.run(req(), async () => "v");
	try {
		await ledger.run(req("k", "other"), async () => "w");
		assert.fail("expected a refusal");
	} catch (error) {
		assert.ok(error instanceof MycocepurusError);
		assert.equal(error.key, "k");
		assert.match(error.message, /^mycocepurus-smithii: /);
	}
});
