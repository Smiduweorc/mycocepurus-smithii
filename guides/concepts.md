---
title: Concepts
---

# Concepts

## Key, scope, fingerprint

A run is about three strings.

- **The key** is the client's promise that two requests are the same request.
  It arrives in the `Idempotency-Key` header as an RFC 8941 String, and the
  ledger sees it unquoted. The draft recommends a UUID; the ledger only
  requires printable ASCII within `maxKeyLength`.
- **The scope** is whose key it is: a user id, an API key id, a tenant. Keys
  from two scopes never meet. It is required because a shared key space lets
  one client read another's response by guessing, and only your auth layer
  knows which client is calling.
- **The fingerprint** is what the request looked like, as a string that is
  equal when the requests are. `mycocepurus-smithii/http` hashes method, path
  and query, and the body bytes. It leaves headers out, because a trace id or
  a refreshed token would turn every honest retry into a mismatch.

The store key is `namespace:scope:key`. Nothing is derived, hashed or escaped
on the way in, so a scope that contains `:` must not also be the prefix of
another scope.

## Lease and retention

Two windows, both yours to size, both in milliseconds.

- **`leaseFor`** is how long a claim is honoured. It should be longer than
  your slowest action, or a slow first attempt and its retry both run. Once it
  passes, the attempt holding it is presumed dead and the next request with
  that key is treated as the first.
- **`retainFor`** is how long a completed outcome is replayed. It is your
  clients' retry horizon. Past it, the same key runs the action again.

The window travels with the entry, so a store's own expiry is a hint for
reclaiming space rather than the source of truth: the ledger re-checks the age
on the way out.

## The claim

Before the action runs, `store.claim` writes an in-flight entry if and only
if nothing live is held under the key. That one operation is the whole
concurrency story. There is no in-memory map of in-flight keys inside the
ledger, because the map would give a different answer in one process than in
twenty; the store gives the same answer in both.

A second copy that arrives while the claim is held is refused with
`in-flight`. The draft says so, and it is the only answer that is the same
across replicas. A caller who wants concurrent in-process copies to share one
execution puts Firefly's `SingleFlight` in front.

## What is stored

Everything `shouldStore` says yes to, including failures. The draft says a
retried request sees the result of the first, success or error, and Stripe
does the same: a client that got a 402 and retries should see the same 402,
not a second attempt to charge the card. `storeAnything` is that answer. If a
503 from your handler should be retryable instead, write a `shouldStore` that
says no to it, and the key is released so the retry runs.

An action that throws is not stored. The key is released and the error is
rethrown unchanged.

## Events

Everything the ledger does is reported to `onEvent` as a plain value: a claim,
a replay with its age, a store, a skip, a release with the action's error, a
refusal with its code, and a store failure with the operation that failed.
Nothing is thrown from a listener, and a listener that throws is ignored.

## Testing

Pass `now` to the ledger and to `MemoryStore`, and move it by hand. The suite
here has no `setTimeout` in it. Every refusal is a `MycocepurusError` with a
`code`, so a test asserts on the code rather than on message text.
