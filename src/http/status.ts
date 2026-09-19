import { MycocepurusError } from "../errors.js";

/**
 * The status the draft names for each refusal: 400 for a missing or malformed
 * key, 409 while the first request is still processing, 422 for a key reused
 * with a different payload. The body is yours.
 *
 * @throws {MycocepurusError} `invalid-options` is a bug in the server, not a
 * fact about the request, so it is rethrown rather than given a status.
 */
export function statusFor(error: MycocepurusError): 400 | 409 | 422 {
	switch (error.code) {
	case "missing-key":
	case "invalid-key":
		return 400;
	case "in-flight":
		return 409;
	case "fingerprint-mismatch":
		return 422;
	case "invalid-options":
		throw error;
	}
}
