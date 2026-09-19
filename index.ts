// Public surface. Everything reachable from here is API you have to keep;
// anything else under `src/` is internal and free to change.
//
// The `.js` extension is required: under `nodenext` resolution the specifier
// must match the emitted file, not the `.ts` source.

export { decide } from "./src/decide.js";
export { MycocepurusError } from "./src/errors.js";
export { fingerprint } from "./src/fingerprint.js";
export { assertKey } from "./src/key.js";
export { Ledger, storeAnything } from "./src/ledger.js";
export { MemoryStore } from "./src/memory-store.js";

export type { MycocepurusErrorCode } from "./src/errors.js";
export type { LedgerOptions, RunRequest } from "./src/ledger.js";
export type { MemoryStoreOptions } from "./src/memory-store.js";
export type {
	Claim,
	Codec,
	Completion,
	Decision,
	Entry,
	Event,
	Outcome,
	ShouldStore,
	Store,
} from "./src/types.js";
