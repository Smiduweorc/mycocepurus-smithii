# mycocepurus-smithii

![A drawn logo of a fungus growing ant](https://raw.githubusercontent.com/Smiduweorc/mycocepurus-smithii/refs/heads/master/assets/logo.png)

mycocepurus-smithii makes a non-idempotent request safe to retry. The client sends an `Idempotency-Key`; the first request runs your handler and every retry gets the stored response back. The same key with a different body is refused, and of two copies arriving at once only one runs.

It follows the IETF's [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/): the header is an RFC 8941 String, a reused key with a different payload is a 422, a concurrent duplicate is a 409, a missing key is a 400.

No runtime dependencies and no `node:` imports. Node 22+ (CI runs 22 and 24 on Linux, macOS and Windows).

## Not included

- Defaults for `retainFor`, `leaseFor` and `maxKeyLength`. They depend on your clients' retry window, your slowest handler and your store, so all three are required.
- Global keys. `scope` is required, so one client cannot replay another's response by guessing a key.
- Making a concurrent copy wait for the first. The draft says it gets a 409. For in-process waiting, put [Firefly](https://github.com/Smiduweorc/firefly)'s `SingleFlight` in front.
- A production store. `MemoryStore` is for one process and for tests; the end of the quick start says what a Redis or Postgres store needs.
- The refusal body. `statusFor` gives you the draft's status; the body is yours.
- Retries. Those are the client's, for example Firefly's `retry`.

## How it works

Every run is a key, a scope and a fingerprint, against a store. What happens depends on what the store holds:

| Store holds | Fingerprint | Result | Draft |
| --- | --- | --- | --- |
| nothing | | claim, run the handler, store the outcome | process |
| a completed entry | same | replay the stored outcome, success or error | replay |
| a completed entry | different | refuse `fingerprint-mismatch` | 422 |
| a live claim | same | refuse `in-flight` | 409 |
| a live claim | different | refuse `fingerprint-mismatch` | 422 |
| an expired claim | any | treated as nothing | |
| no key (`/http` only) | | refuse `missing-key` | 400 |
| a key that is not a Structured Field String, or over your cap | | refuse `invalid-key` | 400 |

The claim is one atomic store operation, so the answer is the same in one process and in twenty. A handler that throws has the key released and the error rethrown unchanged. A store that cannot take the claim has its error rethrown too, so you decide whether to fail the request or run it unguarded.

## Quick start

```sh
npm install mycocepurus-smithii
```

Build a ledger, one per key space, next to the store, and share it:

```ts
import { Ledger, MemoryStore, storeAnything } from "mycocepurus-smithii";
import type { StoredResponse } from "mycocepurus-smithii/http";

const ledger = new Ledger<StoredResponse>({
	store: new MemoryStore({ maxEntries: 10_000 }),
	retainFor: 24 * 60 * 60 * 1000, // your clients' retry horizon
	leaseFor: 30_000,               // longer than your slowest handler
	maxKeyLength: 255,
	shouldStore: storeAnything,     // replay failures too; write your own to skip a 503
});
```

Wrap the handlers that require the header:

```ts
import { idempotent, statusFor } from "mycocepurus-smithii/http";

const createPayment = idempotent(ledger, handlePayment, {
	scope: (request) => sessionOf(request).userId,
	refuse: (error) =>
		Response.json(
			{ error: error.code, docs: "https://api.example.com/docs/idempotency" },
			{ status: statusFor(error) },
		),
});
```

`createPayment` is `(request: Request) => Promise<Response>`, the same shape it wrapped, so it drops into anything that speaks WHATWG `Request`. A request without the header is refused as `missing-key`; wrap only the operations that require it.

Or use a ledger without HTTP, with the same options, typed to what the action returns:

```ts
import { fingerprint } from "mycocepurus-smithii";

const jobs = new Ledger<JobResult>({ store, retainFor, leaseFor, maxKeyLength, shouldStore: storeAnything });

const outcome = await jobs.run(
	{ scope: job.tenantId, key: job.idempotencyKey, fingerprint: await fingerprint([job.type, job.payload]) },
	() => runJob(job),
);
if (outcome.state === "replayed") metrics.increment("jobs.replayed");
```

That covers a queue consumer or a cron that may fire twice.

For more than one process, bring a real store. It has four methods. `claim` is `SET key value NX PX leaseFor`; on a miss, read the entry back and return it. `complete` and `release` take the claim's `owner` and act only while the key still holds that live claim: in Redis each is a Lua script that reads the entry, compares `owner`, then runs `SET key value PX retainFor` or `DEL`; in Postgres they are `UPDATE ... WHERE key = $1 AND owner = $2` and `DELETE ... WHERE key = $1 AND owner = $2`. `forget` is a plain `DEL`. `Codec` says what "value" is on the wire.

## Documentation

Guides and the full API reference are at <https://smiduweorc.github.io/mycocepurus-smithii/>:

- [Concepts](https://smiduweorc.github.io/mycocepurus-smithii/documents/Concepts.html): key, scope, fingerprint, lease and retention, the claim, what is stored, events, testing
- [Boundaries](https://smiduweorc.github.io/mycocepurus-smithii/documents/Boundaries.html): what this package will not do, and where that work goes

The guide sources are in [`guides/`](https://github.com/Smiduweorc/mycocepurus-smithii/tree/master/guides).

On the server the order is auth (which produces `scope`), then the ledger, then the handler. On the client, Firefly's `retry` sends the second copy, and the key says it is the same request.

## Why this exists

At some point, when you get past a few thousand users, retried requests stop being rare. I had a project that required me to work with telemetry, and one of the issues was that mobile users consistently had the largest portion of flaky connections. Perhaps this could be people on data moving around or bad wifi (it was about 2% of mobile users having this issue). Thus, we started needing to implement idempotency on things that were not idempotent by nature, which was a relatively easy problem to solve but we needed to integrate this across a few microservices built on a few different languages (also some other complications because one of the services ran on a windows server).

After solving that problem I realized that it was a problem worth looking into for the context of the javascript ecosystem.

Therefore, I decided to make this library not only because of the problem I had to solve, but also because there is a new [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) regarding the subject matter. This raises another point, a good number of NPM libraries (express-idempotency, @optimuspay/express-idempotency) predate or ignore it and are mostly based on [stripe's blog post](https://stripe.com/blog/idempotency). Which isn't a problem, and if done right will work really well but the draft does important things such as compiling a list of major API providers already using the `Idempotency-Key` convention (and rules for this convention).

Yes this draft is expired, but I am actively watching it in hopes that it goes somewhere.

## License

ISC
