import { MycocepurusError } from "./errors.js";

/**
 * Rejects a key that is not the content of an RFC 8941 String: printable
 * ASCII, `%x20-7E`, at least one character and at most `maxLength`.
 *
 * This is the unquoted value. Quoting and escaping are wire syntax, and
 * `mycocepurus-smithii/http` strips them before the key gets here.
 */
export function assertKey(key: string, maxLength: number): string {
	if (typeof key !== "string" || key.length === 0) {
		throw new MycocepurusError(
			"invalid-key",
			`key must be a non-empty string, received ${String(key)}`
		);
	}
	if (key.length > maxLength) {
		throw new MycocepurusError(
			"invalid-key",
			`key is ${key.length} characters, longer than the ${maxLength} allowed`,
			key
		);
	}
	for (let i = 0; i < key.length; i += 1) {
		const code = key.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			throw new MycocepurusError(
				"invalid-key",
				`key contains a character outside printable ASCII at position ${i}`,
				key
			);
		}
	}
	return key;
}
