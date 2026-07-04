---
title: "Idempotency keys: the one thing that saves you when a webhook fires twice"
description: "Payment gateways retry. Networks drop responses after the work already happened. Here's how idempotency keys stop double charges without slowing anything down."
pubDate: 2026-06-20
tags: ["payments", "reliability", "backend"]
category: "backend"
aiAssisted: false
readingTime: 5
---

At some point every backend developer wiring up a payment gateway learns this the hard way: the request succeeded on your server, but the client never saw the response. The network dropped the reply, the client timed out, or the gateway itself retried because *it* didn't get an acknowledgment in time. From the outside, "did this work?" is not a question your system can answer with certainty — so the caller does the only safe thing it can: it tries again.

If your endpoint isn't ready for that, "again" means a second charge, a second order, a second email. The fix isn't retry avoidance — retries are unavoidable in distributed systems. The fix is making retries safe.

## The core idea

An idempotency key is a unique value the caller generates once per logical operation — a UUID is the usual pick — and sends with every attempt of that operation, including retries. The server's job is to guarantee that no matter how many times a given key shows up, the underlying operation (charge the card, create the order) happens exactly once, and every request with that key gets the same response.

```
POST /payments
Idempotency-Key: 5f1b1c2a-9e3d-4b7a-8b3f-2b6a7c9d0e11

{ "amount": 4999, "currency": "usd", "customer": "cus_123" }
```

## What "handling it" actually requires

The naive version — check if the key exists, if not do the work — has a race condition baked in. Two retries arriving milliseconds apart can both pass the check before either has written a result. You need the check-and-reserve to be atomic.

```sql
INSERT INTO idempotency_keys (key, status, created_at)
VALUES ($1, 'processing', now())
ON CONFLICT (key) DO NOTHING
RETURNING key;
```

If the insert returns a row, you own this key — proceed with the charge, then update the row with the result and response payload. If it doesn't return a row, someone else (a concurrent retry) already claimed it: look up the existing row and return its stored response instead of doing the work again. A unique constraint on `key` is what makes this safe under concurrency, not application-level locking.

## The part people skip: storing the response

It's not enough to prevent the side effect from happening twice — the retry still expects an answer. Store the actual response body (or enough to reconstruct it) alongside the key, keyed by a hash of the request payload too. That second part matters: if someone reuses a key with a *different* payload, that's a client bug, not a legitimate retry, and should return a 422, not silently process the new payload or return a stale response for the wrong request.

## Where the key actually lives

Idempotency keys need to survive exactly as long as retries are plausible for your integration — for most payment gateways that's 24 hours. Store them in the same transactional database as the operation they protect, not in a cache that can evict early or a queue that can redeliver out of order. If the key expires before the retry window closes, you've reintroduced the exact race you built this to prevent.

## Production checklist

- [ ] Idempotency key + request hash both stored, so replays and payload mismatches are handled differently
- [ ] Key uniqueness enforced at the database level, not checked-then-inserted in application code
- [ ] Stored response returned verbatim on retry, not recomputed
- [ ] Expiry window matches (or exceeds) the upstream gateway's actual retry window
- [ ] Webhook handlers get the same treatment as the initial request — they retry too

The pattern is small, but it's the difference between "the payment provider retried and everything was fine" and an incident report titled "why did this customer get charged twice."
