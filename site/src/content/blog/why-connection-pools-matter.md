---
title: "Why your database connection pool is probably misconfigured"
description: "Connection pools look simple until your app falls over at 3am. Here's the math behind sizing them correctly, and the mistakes that get everyone eventually."
pubDate: 2026-07-04
tags: ["postgresql", "backend", "performance"]
category: "backend"
aiAssisted: false
readingTime: 4
---

Every backend developer eventually gets paged for "too many connections." Usually the fix people reach for is bumping `max_connections` on the database. That's almost never the right move.

## The mental model

A connection pool isn't a queue — it's a fixed set of expensive resources (TCP connections, backend processes on Postgres) that your app borrows and returns. More connections doesn't mean more throughput past a certain point, because each Postgres backend process is single-threaded and competes for the same CPU cores and disk I/O.

## A rough sizing formula

A widely used starting point, originally from HikariCP's docs:

```
connections = (core_count * 2) + effective_spindle_count
```

On modern NVMe-backed servers, `effective_spindle_count` is close to 1, so an 8-core database server rarely benefits from more than ~17 connections *per app instance sharing that database*. If you're running 10 replicas of your API, each with a pool of 20, you've handed out 200 connections to a database that performs best around 20.

## What actually happens when you over-provision

- Context switching overhead dominates and total throughput drops
- Postgres's lock manager and buffer manager contend harder as concurrency rises
- Long-tail latency (p99) gets worse even though p50 looks fine

## The fix that isn't "add more connections"

Put a pooler like PgBouncer in transaction mode between your app and Postgres. Your app can hold hundreds of logical connections against PgBouncer, while PgBouncer multiplexes them down to the ~20 physical connections Postgres can actually use efficiently.

## Production checklist

- [ ] Pool size calculated from `(cores * 2) + 1`, not guessed
- [ ] PgBouncer (or equivalent) in front of Postgres for anything beyond a single app instance
- [ ] Alerting on pool wait time, not just pool exhaustion
- [ ] Statement timeout set so one slow query can't hold the whole pool hostage

If you only remember one thing: a bigger pool is not more capacity, it's more contention.
