---
title: Boundaries
---

# Boundaries

**This layer remembers what a key did and refuses to let it do something
else. It does not decide what a request means, who sent it, or what a refusal
looks like on the wire.**

Repletes remembers a value so it need not be computed again. This package
remembers a value so it *cannot* be computed again. The two look alike from
the outside and are opposite in intent: a cache miss is cheap and a duplicate
execution is the bug this exists to prevent, so nothing here is best-effort.

## What this layer owns

- **The key's lifecycle.** First sight, in flight, completed, forgotten. One
  key is in exactly one of those states at any instant, and the transitions
  are the only writes this package makes.
- **The fingerprint check.** A completed key is replayed only when the
  fingerprint stored with it matches the fingerprint of the request in hand. A
  mismatch is a refusal, never a guess about which one the caller meant.
- **The claim.** Before the action runs, the key is claimed in the store with
  one atomic operation. A second copy that arrives while the claim is held is
  refused, not queued and not run.
- **Replaying exactly what was stored**, success or failure, because the draft
  says a retried request sees the first request's outcome, and a client that
  was told "created" must not be told "conflict" on the retry.
- **Releasing a claim the action never finished.** An action that throws frees
  the key so the retry can process; an action that never returns is covered by
  a lease you size.
- **Validating the key's syntax** against RFC 8941 (a Structured Field String:
  printable ASCII, quotes escaped) and a length cap you set.
- **The `Store` contract, plus `MemoryStore`** for one process, and a `Codec`
  shape so out-of-process adapters agree on what an entry looks like on the
  wire.
- **`onEvent`**, reporting every claim, replay, refusal and store failure as a
  plain value.

## What this layer never does

| Excluded | Why | Where it goes |
| --- | --- | --- |
| Reading the request or writing the response | Core sees a key, a fingerprint and an action. Knowing that a key lives in a header and a response has a status pins one protocol on a state machine that has nothing to do with HTTP. | `mycocepurus-smithii/http`, which you import only if you have a WHATWG `Request`. Express, Fastify and friends are an adapter over the same three calls. |
| Deciding who the client is | The draft scopes a key to the client that sent it. If two tenants share a key space, tenant B can replay tenant A's response by guessing a key, which is a data leak. Identity comes from your auth layer, which this package cannot see. | `scope`, a required function from request to client identity. There is no default, because "everyone shares one space" is the wrong default and the types will not let you skip the question. |
| Choosing the error body | The draft says 400, 409 and 422, and says the 400 body should link to documentation. What that body is, in which content type, in which language, is your API's contract. | `refuse`, a required function from a refusal to a `Response`. `statusFor` gives you the draft's number; the body is yours. |
| Deciding which responses are worth remembering | Stripe remembers everything, including 4xx. Another API wants a 500 to be retryable rather than replayed. That is a property of your handler's failure modes. | `shouldStore`, required. `storeAnything` is the explicit opt-in to the Stripe behaviour. |
| Choosing the numbers | How long a key is remembered is a property of your clients' retry windows. How long a claim may be held before it is presumed dead is a property of your slowest handler. The key length cap is a property of your store. | `retainFor`, `leaseFor`, `maxKeyLength`, all required. |
| Waiting for the first attempt | The draft says a concurrent duplicate gets a conflict. Waiting is a concurrency policy with its own timeout and its own answer for a crashed leader, and it only works in one process. | Firefly's `SingleFlight`, in front of this, if a caller wants twenty concurrent copies to share one execution. Across processes, the client retries after the 409. |
| Retries, backoff, deadlines | A retry hidden here turns one execution into several, which is the exact thing the package exists to prevent. | Firefly, wrapping the action, or the client's own retry. |
| Generating keys | The key is the client's promise that two requests are the same request. A server that mints keys for the client has nothing to compare. | The client. The draft recommends a UUID. |
| Hashing headers, cookies, auth tokens into the fingerprint | A fingerprint over volatile headers makes every retry a mismatch. A fingerprint over too little makes every collision a replay. What varies between two honest retries is a property of your clients. | `fingerprint`, a function you can replace. The `/http` one hashes method, target and body, and nothing else. |
| Deciding what happens when the store is down | A claim that cannot be made is a guarantee that cannot be given. Whether to fail the request or run it unguarded is a risk decision. | The `claim` error is rethrown unchanged. Wrap the store, or catch it, and choose. A failed `complete` after a successful action is reported, not thrown, because hiding a result that already happened is worse than replaying nothing. |
| Fleet-wide atomicity | `MemoryStore` is honest about being one process. Two replicas with two memory stores will both run the same key. | A store with an atomic `claim`: `SET NX PX` in Redis, `INSERT ... ON CONFLICT DO NOTHING` in Postgres. The contract is one method. |
| Logging, metrics, `process.env`, work at import time, `node:` imports | Same as every sibling. | `onEvent`; the options object; a constructor call; `globalThis.crypto` for hashing. |

## The states, and the draft's numbers

| Store holds | Fingerprint | Result | Draft says |
| --- | --- | --- | --- |
| nothing | | claim, run the action, store the outcome | process normally |
| a completed entry | same | replay the stored outcome | "respond with the result of the previously completed operation, success or an error" |
| a completed entry | different | refuse `fingerprint-mismatch` | 422 |
| a live claim | same | refuse `in-flight` | 409 |
| a live claim | different | refuse `fingerprint-mismatch` | 422; the mismatch is the more useful thing to say |
| an expired claim | any | treated as nothing | the first attempt died, so the retry is the first attempt now |
| no key at all | | refuse `missing-key` | 400 |
| a key that is not a Structured Field String, or over your cap | | refuse `invalid-key` | 400 |

## One process

`MemoryStore` is for one instance and for tests. It does the claim atomically
because JavaScript is single-threaded and the check-and-set has no `await` in
it. That is a fact about one process and stops being true at two. The store
contract is written so that moving to Redis or Postgres is a constructor
change, and the package will not pretend a memory store is anything else.

## No benchmarks yet

There is no performance claim here, because there is no public harness behind
one yet. When there is, it will run on ordinary CI hardware and the numbers
will be reproducible.
