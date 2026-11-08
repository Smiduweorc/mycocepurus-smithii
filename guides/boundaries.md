---
title: Boundaries
---

# Boundaries

This is not a cache. A cache miss costs a recomputation; here a duplicate
execution is the bug, so nothing is best-effort. The package tracks a key
through first sight, in flight, completed and forgotten, checks the
fingerprint, and replays what was stored. Everything else is listed below
with where it goes.

## Not done here

- Reading the request or writing the response. The core sees a key, a
  fingerprint and an action. HTTP lives in `mycocepurus-smithii/http`, for
  WHATWG `Request`; an Express or Fastify adapter would sit over the same
  three calls.
- Deciding who the client is. That comes from your auth layer, through the
  required `scope` function (see [Concepts](./concepts.md)).
- Choosing the error body. `refuse` is required and returns your `Response`;
  `statusFor` gives the draft's 400, 409 or 422.
- Deciding which outcomes to remember. `shouldStore` is required. Stripe
  remembers everything, 4xx included, and `storeAnything` is that choice;
  write your own if a 500 should be retried instead of replayed.
- Choosing `retainFor`, `leaseFor` and `maxKeyLength`. All required. Set
  `leaseFor` longer than your slowest handler or a slow first attempt and its
  retry both run.
- Waiting for the first attempt. The draft says a concurrent duplicate gets a
  409. Firefly's `SingleFlight` in front of the ledger makes in-process copies
  share one run; across processes, the client retries after the 409.
- Retries, backoff and deadlines. A retry inside the ledger would run the
  action twice. Use Firefly around the action, or the client's own retry.
- Generating keys. The client does that; the draft recommends a UUID.
- Hashing headers, cookies or tokens into the fingerprint. The `/http`
  fingerprint covers method, path and query, and body. Pass your own
  `fingerprint` if you need more.
- Deciding what happens when the store is down. A failed `claim` is rethrown
  unchanged; wrap the store or catch it and choose between failing the
  request and running it unguarded. A failed `complete` after the action ran
  is reported through `onEvent`, not thrown, and the value is returned.
- Logging, metrics and reading `process.env`. Events go to `onEvent`,
  configuration is the options object, and hashing uses
  `globalThis.crypto`.

## One process

`MemoryStore` is atomic only because JavaScript is single-threaded and its
check-and-set has no `await`. It evicts the least recently used entry past
`maxEntries`. Two processes means two stores and a double run, so use a
Redis or Postgres store there; the README's quick start says what one needs.

No benchmarks yet.
