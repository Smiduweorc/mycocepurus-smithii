import { MycocepurusError } from "../errors.js";

/**
 * Read `Idempotency-Key` off a request's headers and hand back its content.
 *
 * The draft makes the field an RFC 8941 Item whose value MUST be a String:
 * double-quoted, printable ASCII, with `\"` and `\\` as the only escapes. A
 * bare token, a list, a parameter or a non-ASCII byte is `invalid-key`. An
 * absent field is `missing-key`, which the draft says is a 400 on an
 * operation that requires it; whether yours does is a routing decision.
 *
 * Length is not checked here. The ledger checks it against `maxKeyLength`.
 */
export function readKey(headers: Headers): string {
	const raw = headers.get("idempotency-key");
	if (raw === null) {
		throw new MycocepurusError("missing-key", "Idempotency-Key header is missing");
	}

	const field = raw.trim();
	if (field.length < 2 || field[0] !== "\"" || field[field.length - 1] !== "\"") {
		throw new MycocepurusError(
			"invalid-key",
			"Idempotency-Key must be a quoted Structured Field String",
			raw
		);
	}

	let out = "";
	for (let i = 1; i < field.length - 1; i += 1) {
		const char = field.charAt(i);
		const code = char.charCodeAt(0);
		if (char === "\\") {
			const next = field.charAt(i + 1);
			if (i + 1 >= field.length - 1 || (next !== "\"" && next !== "\\")) {
				throw new MycocepurusError(
					"invalid-key",
					`Idempotency-Key has an invalid escape at position ${i}`,
					raw
				);
			}
			out += next;
			i += 1;
			continue;
		}
		if (char === "\"" || code < 0x20 || code > 0x7e) {
			throw new MycocepurusError(
				"invalid-key",
				`Idempotency-Key has a character outside printable ASCII at position ${i}`,
				raw
			);
		}
		out += char;
	}

	if (out.length === 0) {
		throw new MycocepurusError("invalid-key", "Idempotency-Key is empty", raw);
	}
	return out;
}
