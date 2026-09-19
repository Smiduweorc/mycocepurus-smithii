import { decide } from "./decide.js";
import { MycocepurusError } from "./errors.js";
import { assertKey } from "./key.js";
import type { Decision, Entry, Event, Outcome, ShouldStore, Store } from "./types.js";

export interface LedgerOptions<T> {
	store: Store<T>;
	/**
	 * How long a completed outcome is replayed, in milliseconds. This is your
	 * clients' retry horizon: past it, the same key runs the action again.
	 */
	retainFor: number;
	/**
	 * How long a claim is honoured before the attempt holding it is presumed
	 * dead, in milliseconds. Longer than your slowest action, or a slow first
	 * attempt and its retry both run.
	 */
	leaseFor: number;
	/** Longest key accepted. A property of what your store is happy to index. */
	maxKeyLength: number;
	/** Whether a completed value is remembered. {@link storeAnything} opts in to all of them. */
	shouldStore: ShouldStore<T>;
	/** Prefixed onto every key. Nothing is derived, hashed or normalised. */
	namespace?: string;
	/** Swappable clock. Defaults to `Date.now`. */
	now?: () => number;
	/** Told about everything. A listener that throws is ignored, not propagated. */
	onEvent?: (event: Event) => void;
}

/** What one run is about. */
export interface RunRequest {
	/**
	 * Whose key this is. Keys from different scopes never meet, so one client
	 * cannot replay another's outcome by guessing a key. Your auth layer knows
	 * this; the ledger does not, so it is required.
	 *
	 * The store key is `namespace:scope:key` with nothing escaped, so a scope
	 * that contains `:` must not also be the prefix of another scope.
	 */
	scope: string;
	/** The client's promise that two requests are the same request. Unquoted. */
	key: string;
	/** What the request looked like, as a string that is equal when the requests are. */
	fingerprint: string;
}

/** Remember every outcome, success or failure. Stripe's answer. */
export const storeAnything: ShouldStore<unknown> = () => true;

const NUMBERS = ["retainFor", "leaseFor", "maxKeyLength"] as const;

/**
 * A store plus every decision about one key space. Construct it once, next to
 * the store, and share it deliberately.
 *
 * The ledger sits between whoever established the caller's identity and the
 * work: it needs a scope from the first and hands the second exactly one
 * chance to run per key.
 */
export class Ledger<T> {
	readonly #store: Store<T>;
	readonly #retainFor: number;
	readonly #leaseFor: number;
	readonly #maxKeyLength: number;
	readonly #shouldStore: ShouldStore<T>;
	readonly #prefix: string;
	readonly #now: () => number;
	readonly #onEvent: ((event: Event) => void) | undefined;

	constructor(options: LedgerOptions<T>) {
		for (const name of NUMBERS) {
			const value = options[name];
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
				throw new MycocepurusError(
					"invalid-options",
					`${name} must be a finite number > 0, received ${String(value)}`
				);
			}
		}
		if (typeof options.shouldStore !== "function") {
			throw new MycocepurusError(
				"invalid-options",
				"shouldStore is required; pass storeAnything to remember every outcome"
			);
		}

		this.#store = options.store;
		this.#retainFor = options.retainFor;
		this.#leaseFor = options.leaseFor;
		this.#maxKeyLength = options.maxKeyLength;
		this.#shouldStore = options.shouldStore;
		this.#now = options.now ?? Date.now;
		this.#onEvent = options.onEvent;
		this.#prefix = options.namespace === undefined ? "" : `${options.namespace}:`;
	}

	/**
	 * Run `action` once per key, or hand back what the first run produced.
	 *
	 * An action that throws has the key released and the error rethrown
	 * unchanged. A store that cannot take the claim has its error rethrown
	 * unchanged too, because a guarantee that cannot be given is not given
	 * quietly. A store that cannot record a finished action is reported through
	 * `onEvent` and the value is still returned, because the work happened; the
	 * claim is left in place, so a retry inside the lease is refused as
	 * `in-flight` rather than run a second time.
	 *
	 * @throws {MycocepurusError} `invalid-key`, `in-flight`, `fingerprint-mismatch`.
	 */
	async run(request: RunRequest, action: () => Promise<T>): Promise<Outcome<T>> {
		const id = this.#id(request.scope, request.key);
		const { fingerprint } = request;

		let held = await this.#claim(id, fingerprint);
		let decision: Decision<T> =
			held === "claimed" ? { state: "first" } : decide(held, fingerprint, this.#now());
		if (held !== "claimed" && decision.state === "first") {
			// The store handed back something past its window, which the contract
			// says it should have treated as absent. One more try, then refuse
			// rather than loop against a store that has forgotten the contract.
			held = await this.#claim(id, fingerprint);
			decision =
				held === "claimed" ? { state: "first" } : decide(held, fingerprint, this.#now());
			if (decision.state === "first") {
				decision = { state: "in-flight", since: this.#now() };
			}
		}

		switch (decision.state) {
		case "replay": {
			this.#emit({ type: "replay", key: id, age: decision.age });
			return { value: decision.value, state: "replayed", age: decision.age };
		}
		case "in-flight": {
			this.#emit({ type: "refuse", key: id, code: "in-flight" });
			throw new MycocepurusError(
				"in-flight",
				`a request with key ${request.key} is still being processed`,
				request.key
			);
		}
		case "mismatch": {
			this.#emit({ type: "refuse", key: id, code: "fingerprint-mismatch" });
			throw new MycocepurusError(
				"fingerprint-mismatch",
				`key ${request.key} was already used with a different request`,
				request.key
			);
		}
		case "first": {
			break;
		}
		}

		this.#emit({ type: "claim", key: id });

		let value: T;
		try {
			value = await action();
		} catch (error) {
			this.#emit({ type: "release", key: id, error });
			await this.#release(id);
			throw error;
		}

		if (!this.#shouldStore(value)) {
			this.#emit({ type: "skip", key: id });
			await this.#release(id);
			return { value, state: "first", age: 0 };
		}

		try {
			await this.#store.complete(id, {
				state: "complete",
				fingerprint,
				value,
				storedAt: this.#now(),
				retainFor: this.#retainFor,
			});
			this.#emit({ type: "store", key: id, retainFor: this.#retainFor });
		} catch (error) {
			this.#emit({ type: "store-error", key: id, operation: "complete", error });
		}
		return { value, state: "first", age: 0 };
	}

	/**
	 * Drop one key. This is the mechanism; deciding that an outcome should no
	 * longer be replayed is the caller's, because the ledger cannot see why.
	 */
	async forget(scope: string, key: string): Promise<void> {
		await this.#release(this.#id(scope, key));
	}

	#id(scope: string, key: string): string {
		if (typeof scope !== "string" || scope === "") {
			throw new MycocepurusError(
				"invalid-options",
				`scope must be a non-empty string, received ${String(scope)}`
			);
		}
		return `${this.#prefix}${scope}:${assertKey(key, this.#maxKeyLength)}`;
	}

	async #claim(id: string, fingerprint: string): Promise<"claimed" | Entry<T>> {
		try {
			return await this.#store.claim(id, {
				state: "in-flight",
				fingerprint,
				claimedAt: this.#now(),
				leaseFor: this.#leaseFor,
			});
		} catch (error) {
			this.#emit({ type: "store-error", key: id, operation: "claim", error });
			throw error;
		}
	}

	async #release(id: string): Promise<void> {
		try {
			await this.#store.release(id);
		} catch (error) {
			this.#emit({ type: "store-error", key: id, operation: "release", error });
		}
	}

	#emit(event: Event): void {
		try {
			this.#onEvent?.(event);
		} catch {
			// A listener's failure is not the ledger's.
		}
	}
}
