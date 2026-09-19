import { MycocepurusError } from "./errors.js";
import type { Claim, Completion, Entry, Store } from "./types.js";

export interface MemoryStoreOptions {
	/** Required. A key space with no ceiling is a leak with a good reputation. */
	maxEntries: number;
	/** Swappable clock, for expiry only. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * In-process store. Evicts the least recently used entry once `maxEntries`
 * is exceeded, and treats entries past their lease or retention as absent.
 *
 * `claim` is atomic here because JavaScript is single-threaded and there is
 * no `await` between the check and the write. That is a fact about one
 * process. Two replicas with two of these will both run the same key, which
 * is why the interface exists and this class is only one of its stores.
 */
export class MemoryStore<T = unknown> implements Store<T> {
	readonly #entries = new Map<string, { entry: Entry<T>; expiresAt: number }>();
	readonly #maxEntries: number;
	readonly #now: () => number;

	constructor(options: MemoryStoreOptions) {
		const { maxEntries } = options;
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new MycocepurusError(
				"invalid-options",
				`MemoryStore maxEntries must be an integer >= 1, received ${String(maxEntries)}`
			);
		}
		this.#maxEntries = maxEntries;
		this.#now = options.now ?? Date.now;
	}

	/** How many entries are held right now. Useful in tests, not a policy input. */
	get size(): number {
		return this.#entries.size;
	}

	async claim(key: string, entry: Claim): Promise<"claimed" | Entry<T>> {
		const held = this.#get(key);
		if (held !== undefined) return held;

		this.#set(key, entry, entry.leaseFor);
		return "claimed";
	}

	/** Expiry is measured against this store's own clock, not the writer's. */
	async complete(key: string, entry: Completion<T>): Promise<void> {
		this.#set(key, entry, entry.retainFor);
	}

	async release(key: string): Promise<void> {
		this.#entries.delete(key);
	}

	#get(key: string): Entry<T> | undefined {
		const slot = this.#entries.get(key);
		if (slot === undefined) return undefined;

		if (this.#now() > slot.expiresAt) {
			this.#entries.delete(key);
			return undefined;
		}

		this.#entries.delete(key);
		this.#entries.set(key, slot);
		return slot.entry;
	}

	#set(key: string, entry: Entry<T>, keepFor: number): void {
		this.#entries.delete(key);
		this.#entries.set(key, { entry, expiresAt: this.#now() + keepFor });

		while (this.#entries.size > this.#maxEntries) {
			const oldest = this.#entries.keys().next();
			if (oldest.done === true) break;
			this.#entries.delete(oldest.value);
		}
	}
}
