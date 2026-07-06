---
title: "Designing a Notification System: Fan-Out and Delivery Guarantees"
description: "Patterns and guarantees for building notification systems that scale: fan-out strategies, retries, idempotency, and delivery guarantees."
pubDate: 2026-07-04
tags:
  - notifications
  - system-design
category: system-design
draft: false
aiAssisted: true
readingTime: 7
linkedinHook: "When a notification needs to reach millions, naive fan-out fails."
---

A celebrity posts something on a platform with 50 million followers. Somewhere behind that button press, a system has to figure out who needs to know, and get a notification onto their phone before they open the app and see it themselves. If that system does the obvious thing — loop over every follower and insert a row — it falls over in seconds. Not because the database is slow, but because the *shape* of the problem changed the moment "one event" needed to become "fifty million writes."

This is the fan-out problem, and almost every system with followers, subscribers, or team members eventually has to solve it: Slack messages, Twitter/X timelines, push notifications, email digests, webhook delivery. The topic sounds like plumbing. It's actually one of the more elegant trade-off spaces in backend engineering.

## The core decision: who pays the cost, and when

Picture a write happening — a new post, a price drop, a comment on a thread you're in. Something needs to turn that one event into "N people see this." There are exactly two places you can do that work.

**Fan-out on write.** The moment the event happens, you immediately compute the list of interested users and write a notification (or a feed entry) into each of their personal inboxes. By the time a user opens the app, their notification list is already sitting there, pre-computed, cheap to read.

**Fan-out on read.** You store the event once. When a user opens the app, you look at everything they're subscribed to and merge it together on the fly — like a search query across every followed source, at read time.

Think of it as a **pre-paid vs. pay-as-you-go** model. Fan-out on write pays the cost once, up front, distributed across every follower's inbox — reads are then nearly free. Fan-out on read defers all cost to read time, which is cheap when nobody's watching but brutal the moment something goes viral, because now every single reader is independently doing the expensive merge.

Here's the visual model: imagine one event as a pebble dropped in a pond. Fan-out on write means you personally walk the pebble's ripple out to every single dock around the pond and hand a bucket of water to each owner immediately. Fan-out on read means you leave the pebble in the water and tell everyone "go check the pond when you feel like it" — cheap for you, but every visitor now has to look at the whole pond themselves.

## Where each pattern is a lifesaver — and where it's an anti-pattern

**Fan-out on write shines** when the read path massively outnumbers the write path — a typical social feed is read dozens of times for every post that's written. Pre-computing means reads stay O(1): fetch your inbox, done.

It becomes an anti-pattern the moment one write has an enormous number of recipients. A user with 50 million followers turns "one write" into "50 million writes," and that write now has unbounded, unpredictable latency — the classic **celebrity problem**. If your write path's latency depends on how famous the *poster* is, you've built a system that fails exactly when it matters most (their biggest moment).

**Fan-out on read shines** for exactly that celebrity case, and for any "firehose" scenario where most content is never actually consumed by most subscribers — computing it lazily, only for the fraction of followers who actually open the app, wastes far less work.

It becomes an anti-pattern when a user follows thousands of sources — every page load now merges thousands of timelines in real time, which is exactly the kind of unbounded, per-request fan-in that pages you at 2am.

The systems that actually work at scale (Twitter's timeline architecture is the textbook example) use **both**: fan-out on write for regular users, falling back to fan-out on read for accounts with huge follower counts, merged together at serving time. The trade-off isn't binary — it's a dial you tune per-account based on follower count.

## Implementation: from "obviously wrong" to production-shaped

The naive version looks harmless in a demo:

```typescript
// Naive: works for 10 followers, falls over at 10,000+
async function notifyFollowers(eventId: string, authorId: string) {
  const followers = await db.query(
    'SELECT user_id FROM follows WHERE followee_id = $1',
    [authorId]
  );

  for (const { user_id } of followers.rows) {
    await db.query(
      'INSERT INTO notifications (user_id, event_id) VALUES ($1, $2)',
      [user_id, eventId]
    );
  }
}
```

This has three separate failure modes hiding in six lines: it holds an HTTP request open for as long as the largest fan-out takes, it does one round-trip per follower against the database, and if the process crashes at follower #40,000 of 50,000, there's no record of where it stopped — some users get notified, some silently don't, and nobody can tell you which.

The production-shaped version separates "accept the event" from "deliver the event," and treats delivery as a durable, retryable, resumable job:

```typescript
// 1. The write path only enqueues — it returns in milliseconds regardless
//    of fan-out size, because it does zero per-follower work.
async function onNewPost(eventId: string, authorId: string) {
  await queue.publish('fanout.requested', { eventId, authorId });
}

// 2. A worker does the actual fan-out, in bounded batches, and writes an
//    idempotency key per recipient so a retried batch can't double-notify.
async function handleFanoutRequested({ eventId, authorId }: FanoutJob) {
  const BATCH_SIZE = 1000;
  let cursor: string | null = null;

  do {
    const { rows, nextCursor } = await getFollowersPage(authorId, cursor, BATCH_SIZE);

    // ON CONFLICT DO NOTHING makes this batch safe to replay after a crash —
    // re-running it is a no-op for followers already notified.
    await db.query(
      `INSERT INTO notifications (user_id, event_id, idempotency_key)
       SELECT unnest($1::uuid[]), $2, $2 || ':' || unnest($1::uuid[])
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [rows.map((r) => r.user_id), eventId]
    );

    cursor = nextCursor;
  } while (cursor);
}
```

The key shift: the write path's latency no longer depends on follower count — it's a constant-time enqueue. All the variable, potentially-huge work moves to a background worker that processes in bounded batches and can crash and resume from wherever it left off, because every batch is safely re-runnable.

## Senior-level insights and gotchas

**"At-least-once" is the only honest guarantee at scale.** Exactly-once delivery across a network is a famously impossible guarantee to make for free — the practical answer everyone actually ships is at-least-once delivery plus idempotency on the receiving end. That's why the idempotency key above isn't decoration; it's the entire mechanism that turns "might deliver twice" into "delivering twice is harmless."

**Backpressure is not optional once you have a queue.** The moment fan-out becomes async, you've introduced a queue between "event happened" and "user notified" — and queues that grow unbounded during a traffic spike become the next outage. Cap in-flight jobs per worker, and prefer **shedding low-priority notification classes** (a "someone liked your post" digest) before you ever let the queue depth threaten your database or your paging alerts.

**Multi-channel delivery needs its own retry policy per channel.** Push notifications, email, and SMS fail differently and at different rates — an SMS provider outage shouldn't block or retry-storm your push notification path. Treat each channel as an independent job with its own backoff, not one job that "sends everywhere" and fails as a unit.

**The celebrity problem doesn't go away — it moves.** Switching a huge account to fan-out-on-read fixes the write-path spike, but now every one of their followers' feed reads has to merge in that account's content at read time. You haven't eliminated the cost, you've relocated it from "one bad write" to "many read-time merges" — which is usually the right trade, but know that you're making a trade, not a free fix.

## Production checklist

- [ ] Write path enqueues a job and returns — it does not loop over recipients synchronously
- [ ] Fan-out workers process in bounded batches with a resumable cursor, not one unbounded pass
- [ ] Every notification write carries an idempotency key so retried batches can't double-notify
- [ ] Queue depth and worker lag are alerted on — not just error rates
- [ ] High-follower-count accounts (or any "hot" fan-out target) have an explicit fallback path, whether that's read-time fan-in or heavy batching
- [ ] Each delivery channel (push, email, SMS) retries and fails independently of the others

If you only remember one thing: fan-out isn't a feature, it's a cost — and the whole design question is *where and when* that cost gets paid.
