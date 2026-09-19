import type { Decision, Entry } from "./types.js";

/**
 * The whole policy, over one entry, at one instant.
 *
 * | Store holds | Fingerprint | Decision |
 * | --- | --- | --- |
 * | nothing | | `first` |
 * | a completion within `retainFor` | same | `replay` |
 * | a completion within `retainFor` | different | `mismatch` |
 * | a claim within `leaseFor` | same | `in-flight` |
 * | a claim within `leaseFor` | different | `mismatch` |
 * | either, past its window | any | `first` |
 *
 * A mismatch wins over an in-flight claim because "you sent a different body
 * under a used key" is something the caller can act on and "try later" is not.
 *
 * A clock that went backwards is treated as an entry written this instant. A
 * store handing back something from the future is not a reason to throw.
 */
export function decide<T>(
	entry: Entry<T> | undefined,
	fingerprint: string,
	now: number
): Decision<T> {
	if (entry === undefined) return { state: "first" };

	if (entry.state === "in-flight") {
		const age = Math.max(0, now - entry.claimedAt);
		if (age > entry.leaseFor) return { state: "first" };
		if (entry.fingerprint !== fingerprint) {
			return { state: "mismatch", held: "in-flight" };
		}
		return { state: "in-flight", since: entry.claimedAt };
	}

	const age = Math.max(0, now - entry.storedAt);
	if (age > entry.retainFor) return { state: "first" };
	if (entry.fingerprint !== fingerprint) {
		return { state: "mismatch", held: "complete" };
	}
	return { state: "replay", value: entry.value, age };
}
