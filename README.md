# mycocepurus-smithii [WIP]

![A drawn logo of a fungus growing ant](https://raw.githubusercontent.com/Smiduweorc/mycocepurus-smithii/refs/heads/master/assets/logo.png)

Mycocepurus-smithii is a small TypeScript library that makes a non-idempotent HTTP request (POST, PATCH) safe to send more than once. The caller sends an `Idempotency-Key` header; the library fingerprints the request, checks a store you supply for a prior attempt with that key, and either passes the request through for the first time or replays the exact stored response for every retry after. A key reused with a different request body is a hard conflict, not a guess. No bundled storage backend, no framework baked in, no retry logic of its own, just the one guarantee, done to spec.

### Why this exists:

At some point, when you get past a few thousand users, retried requests will stop becoming rare. I had a project that required me to work with telemetry, and one of the issue was that mobile users consistently had the largest portion of flaky connections. Perhaps this could be people on data moving around or bad wifi (it was about 2% of mobile users having this issue). Thus, we started needing to implement idempotency on things that were not idempotent by nature, which was a relatively easy problem to solve but we needed to integrate this across a few microservices built on a few different languages (also some other complications because one of the services ran on a windows server).

After solving that problem I realized that it was a problem worth looking into for the context of the javascript ecosystem.

Therefore, I decided to make this library not only because of the problem I had to solve, but also because there is a new [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) regarding the subject matter. This raises another point, a good number of NPM libraries (express-idempotency, @optimuspay/express-idempotency) predates or ignores it and are mostly based on [stripe's blog post](https://stripe.com/blog/idempotency). Which isn't a problem, and if done right will work really well but the draft does important things such as compiling a list of major API providers already using the `Idempotency-Key` convention (and rules for this convention).

Yes this draft is expired, but I am actively watching it in hopes that it goes somewhere.