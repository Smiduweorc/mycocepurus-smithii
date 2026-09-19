/**
 * What a store holds under one key.
 *
 * The fingerprint travels with the entry so that a hit can be checked against
 * the request in hand, and the window travels with it so that expiry is
 * re-checked on the way out rather than trusted to the store. Every number is
 * milliseconds from the clock of whoever wrote the entry.
 */
export type Entry<T> =
	| {
			state: "in-flight";
			fingerprint: string;
			/** When the claim was taken. */
			claimedAt: number;
			/** How long past `claimedAt` the claim is honoured before the attempt is presumed dead. */
			leaseFor: number;
	  }
	| {
			state: "complete";
			fingerprint: string;
			value: T;
			/** When the action finished. */
			storedAt: number;
			/** How long past `storedAt` the value is replayed. */
			retainFor: number;
	  };

/** The entry a claim writes. */
export type Claim = Extract<Entry<never>, { state: "in-flight" }>;

/** The entry a completed action writes. */
export type Completion<T> = Extract<Entry<T>, { state: "complete" }>;

/**
 * Where the keys live. Async everywhere, including in memory, so that moving
 * from a process-local store to a networked one is a constructor change.
 *
 * `claim` is the whole guarantee. It MUST be atomic: two callers claiming one
 * key at once see exactly one `"claimed"`. It MUST treat a claim whose lease
 * has expired, and a completion whose retention has expired, as absent, so a
 * retry of a dead attempt can become the first attempt. `SET NX PX` in Redis
 * and `INSERT ... ON CONFLICT DO NOTHING` in Postgres are both this method.
 * Everything else is bookkeeping.
 */
export interface Store<T = unknown> {
	/** Write `entry` only if nothing live is held under `key`. Returns `"claimed"`, or what is held. */
	claim(key: string, entry: Claim): Promise<"claimed" | Entry<T>>;
	/**
	 * Replace the claim with the outcome. `entry.retainFor` is a hint for
	 * reclaiming space; the age is re-checked on the way out and store expiry is
	 * never trusted for correctness.
	 */
	complete(key: string, entry: Completion<T>): Promise<void>;
	/** Drop whatever is held. Called when an action threw, or on `forget`. */
	release(key: string): Promise<void>;
}

/**
 * How an out-of-process {@link Store} turns entries into something it can
 * hold. Never called by this package; it is here so adapters agree on a shape.
 */
export interface Codec<T, Wire = string> {
	encode(entry: Entry<T>): Wire | Promise<Wire>;
	decode(wire: Wire): Entry<T> | Promise<Entry<T>>;
}

/** The policy decision over one entry. Pure: no store, no clock, no promises. */
export type Decision<T> =
	| { state: "first" }
	| { state: "replay"; value: T; age: number }
	| { state: "in-flight"; since: number }
	| { state: "mismatch"; held: "in-flight" | "complete" };

/**
 * What a run produced, and whether the action ran to produce it. `age` is
 * zero when the action produced it.
 */
export interface Outcome<T> {
	value: T;
	state: "first" | "replayed";
	age: number;
}

/**
 * Decides whether a completed value is worth remembering. Returning `false`
 * releases the key, so the next request with it runs the action again.
 */
export type ShouldStore<T> = (value: T) => boolean;

/**
 * Everything observable. Reported, never thrown.
 *
 * `release` and `store-error` carry what went wrong; the rest are facts about
 * what the ledger did, so a listener counts them without unpacking an error it
 * does not need. `key` is the full store key, namespace and scope included.
 */
export type Event =
	| { type: "claim"; key: string }
	| { type: "replay"; key: string; age: number }
	| { type: "store"; key: string; retainFor: number }
	/** `shouldStore` declined, so the key was released instead. */
	| { type: "skip"; key: string }
	/** The action threw. The error is rethrown to the caller after this. */
	| { type: "release"; key: string; error: unknown }
	| { type: "refuse"; key: string; code: "in-flight" | "fingerprint-mismatch" }
	| {
			type: "store-error";
			key: string;
			operation: "claim" | "complete" | "release";
			error: unknown;
	  };
