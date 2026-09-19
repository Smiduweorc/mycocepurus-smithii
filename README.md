# mycocepurus-smithii

![A drawn logo of a fungus growing ant](https://raw.githubusercontent.com/Smiduweorc/mycocepurus-smithii/refs/heads/master/assets/logo.png)

**Mycocepurus-smithii makes a non-idempotent request safe to send more than once. The client sends an `Idempotency-Key`; the ledger claims it, runs your handler exactly once, and replays the stored response to every retry. A key reused with a different body is a hard conflict, and two copies arriving at once produce one execution.**

It follows the IETF's [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/): the header is an RFC 8941 String, a reused key with a different payload is a 422, a concurrent duplicate is a 409, a missing key is a 400. No bundled storage backend, no framework baked in, no retry logic of its own.

No runtime dependencies, no `node:` imports, and nothing happens at import time.

## This is not for you if you

- **want it to pick the numbers.** How long a key is remembered, how long a claim may be held, and how long a key may be are properties of your clients and your store. All three are required.
- **want keys to be global.** `scope` is required: a key belongs to the client that sent it, and one client must not be able to replay another's response by guessing.
- **want the second concurrent copy to wait for the first.** The draft says it gets a conflict. Waiting is [Firefly](https://github.com/Smiduweorc/firefly)'s `SingleFlight`, in front of this.
- **want a store shipped.** `MemoryStore` is for one process and for tests. The `Store` contract is three methods, and the atomic one is `SET NX` in Redis.
- **want it to write the 409.** `statusFor` gives you the draft's number; the body is your API's contract.

## How it works

Every run is a key, a scope and a fingerprint, against a store. The store answers one of four ways:

| Store holds | Fingerprint | Result | Draft |
| --- | --- | --- | --- |
| nothing | | claim, run the handler, store the outcome | process |
| a completed entry | same | replay the stored outcome, success or error | replay |
| a completed entry | different | refuse `fingerprint-mismatch` | 422 |
| a live claim | same | refuse `in-flight` | 409 |
| a live claim | different | refuse `fingerprint-mismatch` | 422 |
| an expired claim | any | treated as nothing | |

The claim is one atomic store operation, so the answer is the same in one process and in twenty. A handler that throws has the key released and the error rethrown unchanged. A store that cannot take the claim has its error rethrown too, because a guarantee that cannot be given is not given quietly.

## Quick start

```sh
npm install mycocepurus-smithii
```

**1. Build a ledger.** One per key space, next to the store, shared.

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

Every number is required. There is no default retention and no default lease.

**2. Wrap the handlers that require the header.**

```ts
import { idempotent, statusFor } from "mycocepurus-smithii/http";

const createPayment = idempotent(ledger, handlePayment, {
	scope: (request) => sessionOf(request).userId,
	refuse: (error) =>
		Response.json(
			{ error: error.code, docs: "https://api.acme.com/docs/idempotency" },
			{ status: statusFor(error) },
		),
});
```

`createPayment` is `(request: Request) => Promise<Response>`, the same shape it wrapped, so it drops into anything that speaks WHATWG `Request`. A request without the header is refused as `missing-key`; wrap only the operations that require it.

**3. Or use a ledger without HTTP.** Same options, typed to what the action returns.

```ts
import { fingerprint } from "mycocepurus-smithii";

const jobs = new Ledger<JobResult>({ store, retainFor, leaseFor, maxKeyLength, shouldStore: storeAnything });

const outcome = await jobs.run(
	{ scope: job.tenantId, key: job.idempotencyKey, fingerprint: await fingerprint([job.type, job.payload]) },
	() => runJob(job),
);
if (outcome.state === "replayed") metrics.increment("jobs.replayed");
```

Same guarantee for a queue consumer or a cron that may fire twice.

**4. Bring a real store.** Three methods. `claim` is `SET key value NX PX leaseFor`; on a miss, read the entry back and return it. `complete` is `SET key value PX retainFor`. `release` is `DEL`. `Codec` says what "value" is on the wire.

## Documentation

Guides and the full API reference: **<https://smiduweorc.github.io/mycocepurus-smithii/>**

| Guide | What it covers |
| --- | --- |
| [Concepts](https://smiduweorc.github.io/mycocepurus-smithii/documents/Concepts.html) | Key, scope, fingerprint; lease and retention; the claim; what is stored; events; testing |
| [Boundaries](https://smiduweorc.github.io/mycocepurus-smithii/documents/Boundaries.html) | What this package will not do, and where that work goes |

The guide sources live in [`guides/`](https://github.com/Smiduweorc/mycocepurus-smithii/tree/master/guides).

## Where it sits

| Package | Question it answers |
| --- | --- |
| [dung beetle](https://github.com/Smiduweorc/dung-beetle-template) / Aphid | What is this API, and what happened? |
| [Firefly](https://github.com/Smiduweorc/firefly) | What do I do about a failure on a call I make? |
| [Repletes](https://github.com/Smiduweorc/Repletes) | Do I need to compute this again? |
| **mycocepurus-smithii** | **Has this request already happened, and am I allowed to run it again?** |

On the server: auth, which produces `scope`, then the ledger, then the handler. Firefly's `retry` on the client is what sends the second copy; the header is the client's promise that it is the same request, and this package is the server holding it to that promise. [Boundaries](https://smiduweorc.github.io/mycocepurus-smithii/documents/Boundaries.html) has the full list of what it rules out.

### Why this exists:

At some point, when you get past a few thousand users, retried requests will stop becoming rare. I had a project that required me to work with telemetry, and one of the issue was that mobile users consistently had the largest portion of flaky connections. Perhaps this could be people on data moving around or bad wifi (it was about 2% of mobile users having this issue). Thus, we started needing to implement idempotency on things that were not idempotent by nature, which was a relatively easy problem to solve but we needed to integrate this across a few microservices built on a few different languages (also some other complications because one of the services ran on a windows server).

After solving that problem I realized that it was a problem worth looking into for the context of the javascript ecosystem.

Therefore, I decided to make this library not only because of the problem I had to solve, but also because there is a new [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) regarding the subject matter. This raises another point, a good number of NPM libraries (express-idempotency, @optimuspay/express-idempotency) predates or ignores it and are mostly based on [stripe's blog post](https://stripe.com/blog/idempotency). Which isn't a problem, and if done right will work really well but the draft does important things such as compiling a list of major API providers already using the `Idempotency-Key` convention (and rules for this convention).

Yes this draft is expired, but I am actively watching it in hopes that it goes somewhere.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` and the barrels to `dist/` with type declarations. |
| `npm run typecheck` | Type-check the package and the tests without emitting. |
| `npm run lint` | Run ESLint. |
| `npm test` | Run the test suite with the Node test runner via `tsx`. |
| `npm run docs` | Build the documentation site into `docs/`. |
| `npm run changelog` | Regenerate `CHANGELOG.md` from the commit history. |

> Publishing and deployment are handled manually (custom npm settings), so no release/publish workflow is included here.

## License

ISC
