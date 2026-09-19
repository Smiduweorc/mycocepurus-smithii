// The "mycocepurus-smithii/http" entry point. Nothing in the core surface
// imports it, so a consumer with no WHATWG `Request` in sight pulls in no HTTP.

export { fingerprintRequest } from "./src/http/fingerprint.js";
export { idempotent } from "./src/http/idempotent.js";
export { readKey } from "./src/http/key.js";
export { statusFor } from "./src/http/status.js";
export { fromStored, toStored } from "./src/http/stored.js";

export type { Handler, IdempotentOptions } from "./src/http/idempotent.js";
export type { StoredResponse } from "./src/http/stored.js";
