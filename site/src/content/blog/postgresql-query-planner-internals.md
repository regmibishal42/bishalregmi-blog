---
title: "PostgreSQL Query Planner Internals: How the Cost-Based Optimizer Chooses a Plan"
description: "An overview of PostgreSQL's planner: cost model, statistics, join ordering, and why the wrong plan gets chosen sometimes."
pubDate: 2026-07-04
tags:
  - postgresql
  - backend
  - performance
category: postgresql
draft: false
aiAssisted: true
readingTime: 8
linkedinHook: "Why does Postgres pick a sequential scan when you expected an index?"
---

You add an index, run the query, and it still does a sequential scan. Not because Postgres is broken — because it did the math and decided the index would be *slower*. That sentence is where most developers' mental model of databases breaks down: an index isn't a switch you flip on, it's an option the planner is free to ignore. Understanding why requires understanding that Postgres doesn't execute the query you wrote — it executes a plan it *estimated* would be cheapest, and estimates can be wrong.

## The mental model: a cost estimator, not a rule engine

Every query you send to Postgres goes through a **planner** that doesn't look for a "correct" plan — it enumerates several candidate plans and picks the one with the lowest *estimated cost*, measured in arbitrary units that roughly track disk I/O and CPU work. There is no execution involved in choosing the plan — it's pure estimation, based on statistics Postgres has cached about your tables.

Picture tracking one query end-to-end: `SELECT * FROM orders WHERE customer_id = 42`. The planner has two real candidate strategies — walk an index on `customer_id` and fetch each matching row, or scan the whole table and filter as it goes. It assigns each a cost:

- **Sequential scan**: cost ≈ `(number of pages in the table) × seq_page_cost`, plus a small CPU cost per row examined.
- **Index scan**: cost ≈ `(number of matching rows) × random_page_cost`, plus the cost of walking the index tree itself.

`seq_page_cost` defaults to `1.0` and `random_page_cost` defaults to `4.0` — sequential reads are modeled as four times cheaper *per page* than random reads, because on spinning disks, jumping around is expensive. If `customer_id = 42` matches 40% of a 10,000-row table, reading 4,000 rows via random-access index lookups can cost more, in this model, than sequentially reading the whole table once. The index isn't "worse" in some abstract sense — the math, given the *selectivity* of your filter, genuinely favors the scan.

## Real-world use cases: where the planner is a lifesaver, and where it betrays you

The planner is a lifesaver for **ad-hoc, unpredictable queries** — dashboards, reporting tools, anything where you can't hand-write an optimal plan for every possible filter combination a user might click through. You get "good enough, automatically" for a near-infinite space of queries.

It becomes an anti-pattern the moment your statistics go stale relative to your data. Right after a bulk insert or a lopsided data distribution (say, 90% of orders belong to one enterprise customer), the planner's row-count estimates — built from the last `ANALYZE` — can be wildly wrong, and a wildly wrong estimate produces a wildly wrong plan. This is the single most common cause of "it was fast yesterday, it's slow today" tickets that have nothing to do with load.

## Implementation: reading the plan Postgres actually chose

`EXPLAIN` shows you the *estimated* plan. `EXPLAIN (ANALYZE, BUFFERS)` actually runs the query and shows you estimate vs. reality side by side — that gap is the single most useful diagnostic in Postgres performance work.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE customer_id = 42;
```

```
Seq Scan on orders  (cost=0.00..1834.00 rows=4021 width=96)
                     (actual time=0.031..12.442 rows=6 loops=1)
  Filter: (customer_id = 42)
  Rows Removed by Filter: 9994
  Buffers: shared hit=834
```

Read the numbers, not just the plan shape: the planner *estimated* 4,021 matching rows and got 6. That's not a rounding error — that's the planner making a confident, badly wrong bet based on stale or coarse statistics, and choosing a sequential scan because it genuinely believed an index would be pointless for something matching 40% of the table.

The fix isn't to force an index with a query hint (Postgres deliberately has no hint syntax, precisely to stop developers from freezing a plan choice that stale statistics will eventually make wrong again). The fix is to give the planner better information:

```sql
-- Naive fix: developers reach for this and it usually doesn't help, because
-- the problem was never that the index was missing.
CREATE INDEX idx_orders_customer_id ON orders (customer_id);

-- Actual fix: refresh the statistics the planner's cost model depends on.
ANALYZE orders;

-- If one column's values are wildly skewed (a few customers dominate the
-- table) and simple ANALYZE isn't enough, tell the planner explicitly —
-- extended statistics capture correlation and distribution single-column
-- stats miss entirely.
CREATE STATISTICS orders_customer_stats (ndistinct) ON customer_id, order_date FROM orders;
ANALYZE orders;
```

`ANALYZE` rebuilds the histogram and most-common-values list Postgres uses to estimate selectivity. In a live system, this should never be a manual, remembered step — it should be autovacuum's job, tuned correctly (see the gotcha below), because a human remembering to run `ANALYZE` after every bulk load is not a reliability strategy.

## Senior-level insights and gotchas

**Autovacuum's default thresholds are tuned for small tables, not yours.** The default `autovacuum_analyze_scale_factor` triggers a re-analyze only after 10% of a table's rows have changed. On a 100-million-row table, that's 10 million row changes before statistics refresh — an enormous, silent staleness window. For high-write tables, lower the scale factor explicitly (`ALTER TABLE orders SET (autovacuum_analyze_scale_factor = 0.02)`), or you're flying blind on exactly the tables where bad plans hurt most.

**`random_page_cost = 4.0` assumes a spinning disk you almost certainly don't have.** On modern NVMe/SSD-backed instances (which is nearly everyone's production database now), random and sequential I/O cost roughly the same. Leaving the default in place systematically biases the planner *against* index scans on hardware where index scans are actually cheap. Dropping `random_page_cost` to `1.1`–`1.5` is one of the highest-leverage, most under-used tuning changes available — it's a one-line config change that re-aligns the planner's cost model with the hardware it's actually running on.

**Join order is a combinatorial search, and Postgres gives up on purpose.** For queries joining more than `join_collapse_limit` tables (default 8), Postgres switches from exhaustively evaluating every join order to a genetic algorithm (`geqo`) that finds a *good* order, not necessarily the best one. If you have wide, many-table joins that seem to plan inconsistently between runs, this is why — and it's a strong signal to either restructure the query or explicitly raise the limit if you've measured that exhaustive search is worth the extra planning time.

**Common Table Expressions used to be optimization fences.** Before Postgres 12, every `WITH` clause was materialized and optimized in isolation — the planner couldn't push filters from the outer query into the CTE. Postgres 12+ inlines non-recursive CTEs by default, but if you're maintaining an older version, or you explicitly wrote `WITH x AS MATERIALIZED (...)`, that CTE is planned in a vacuum, and can silently choose a much worse plan than the equivalent inlined subquery would.

## Production checklist

- [ ] `autovacuum_analyze_scale_factor` tuned per-table for high-write tables, not left at the global default
- [ ] `random_page_cost` adjusted to match real hardware (≈1.1–1.5 for SSD/NVMe, not the spinning-disk default of 4.0)
- [ ] `EXPLAIN (ANALYZE, BUFFERS)` is the first diagnostic step for "it got slow," not adding an index blindly
- [ ] Estimated vs. actual row counts checked for large gaps — that gap, not the plan shape, is the real signal
- [ ] Extended statistics (`CREATE STATISTICS`) in place for columns with skewed or correlated distributions
- [ ] No query hints or forced plans — fix the statistics the planner is estimating from, not the symptom

If you only remember one thing: Postgres isn't ignoring your index, it's doing arithmetic — and the arithmetic is only as good as the statistics you fed it.
