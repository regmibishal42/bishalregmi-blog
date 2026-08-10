---
title: Why Your 16-Core Database Isn't Multithreading Queries
description: >-
  Your beefy database server has 16 cores, but queries feel slow. Discover why
  PostgreSQL might not be using parallel execution, and how to fix it.
pubDate: '2026-08-10'
tags:
  - postgresql
  - parallel-query
  - database
  - performance
  - backend
category: postgresql
draft: false
aiAssisted: true
readingTime: 13
linkedinHook: >-
  Your 16-core database server is running a massive analytical query, but htop
  shows only one core spiking. What's going on?
linkedinBody: >-
  I just wrote about why your PostgreSQL queries might not be using all
  available CPU cores, even on powerful machines. We explore how parallel
  execution works, common pitfalls, and the exact settings to tune. It's a
  game-changer for data warehousing and complex reports.
---
## Introduction & hook

The production alarm blares. A critical dashboard report, usually taking under a minute, is now grinding for five, ten, fifteen minutes. You SSH into the database server, a beast with 16 cores and gobs of RAM. `htop` flashes on screen, and your stomach drops: one CPU core is pegged at 100%, the other fifteen are practically idle. Your shiny, powerful server is doing the work of a potato, and your users are fuming.

This isn't just frustrating; it’s a direct hit to your system's efficiency and your team's sanity. The culprit? Often, a misunderstanding of **parallel query execution**. Databases like PostgreSQL are incredibly smart, designed to break down a single, complex SQL query into smaller, independent tasks that can run concurrently across multiple CPU cores. This isn't just about making queries faster; it's about making them *possible* within reasonable timeframes on massive datasets.

When your queries aren't parallelizing, you're leaving vast amounts of computational power on the table. You're bottlenecking an entire system around a single core, leading to slow reports, stale dashboards, and frustrated users. Understanding *why* your queries might skip this superpower, and how to enable it, is crucial for any engineer working with serious data volumes.

## How it works (the visual example)

Imagine you're running a massive e-commerce platform. Every user interaction, every product view, every click generates a record. You need to calculate the average time users spend on product pages, grouped by product category, for the past year. That's billions of rows.

Running this sequentially is like asking one person to read every book in a massive library and then categorize them. It's possible, but it will take forever.

**Parallel query execution** changes the game. Think of it like a coordinated team effort:

1.  **The Leader Process:** Your main SQL session acts as the "manager." When you run a query that the database optimizer deems suitable for parallelization, this leader process spins up several **parallel worker processes**. Each worker is essentially a mini-database session, ready to do some heavy lifting.
2.  **Distributed Work:** The database intelligently divides the data. If you're scanning a huge table, each worker gets a contiguous chunk of that table to process simultaneously.
    *   For our e-commerce example, one worker might scan product view data for January, another for February, and so on.
    *   If you're performing a **parallel hash join** (e.g., joining your massive `product_views` table with an equally huge `products` table), workers don't just scan parts of one table. They can each build *parts* of the hash table from their assigned chunk of the smaller table, or probe *parts* of the larger table against a shared hash table, drastically speeding up the join operation.
3.  **Gathering Results (Gather/Gather Merge):** Once the workers complete their individual tasks, their partial results need to be combined.
    *   A **Gather** node in the query plan is like the manager process collecting discrete, independent results from each worker. Imagine each worker counting "page views" for their month and then reporting back their total. The manager then simply sums these up.
    *   A **Gather Merge** node is more sophisticated. If workers produce *sorted* output (e.g., they each sort their monthly data by `product_category`), the manager can then efficiently merge these pre-sorted streams into a single, fully sorted result set without having to sort the entire dataset again. This is like each worker sorting their pile of books by author, and then the manager seamlessly combining all the sorted piles into one grand, sorted list.

This whole orchestrated dance ensures that your query leverages all available muscle, turning a sequential crawl into a multi-core sprint.

## Real-world use cases

Parallel query execution isn't a silver bullet; it's a specialized tool that shines in specific scenarios and can even be detrimental in others.

**Where it's a lifesaver:**

*   **Complex Analytical Queries:** Anything that scans large portions of big tables, performs aggregations (`SUM`, `COUNT`, `AVG`), or complex joins. Think financial reports, data warehousing queries, or generating aggregate statistics across millions of events.
*   **Batch Processing & ETL:** When you're transforming or loading large datasets, parallel operations can drastically cut down execution times for stages like `INSERT ... SELECT` or `CREATE TABLE AS SELECT`.
*   **Large Index Builds:** In some databases, building indexes on massive tables can be parallelized, though this often impacts concurrent write operations.
*   **Heavy Joins:** Specifically, **parallel hash joins** excel when joining two large tables where at least one fits into memory after partitioning.

**Where it becomes an anti-pattern:**

*   **OLTP Workloads:** Short, highly concurrent transactional queries (e.g., `INSERT` a single row, `SELECT` by primary key, `UPDATE` a single record) don't benefit. The overhead of coordinating parallel workers far outweighs any potential gains for these quick operations.
*   **Small Datasets:** If your table has only a few thousand rows, or your query is very selective, the data volume might not be large enough to justify the worker startup and coordination costs.
*   **I/O-Bound Queries:** If your bottleneck is disk read/write speed (e.g., your data is on slow spinning disks, or your storage system is saturated), throwing more CPU cores at the problem won't help. The query is waiting on data, not computation.
*   **Queries with Strong Locking Requirements:** Queries involving `FOR UPDATE` or `FOR SHARE` locks on many rows can easily serialize parallel workers, negating the benefits.
*   **High Concurrency with Limited Resources:** If your server is already strained by hundreds of concurrent connections, spawning many parallel workers for a single query can starve other queries and lead to overall system degradation.

## Implementation & code

Let's look at how PostgreSQL indicates and enables parallel execution. We'll use `EXPLAIN ANALYZE` to see the query plan.

First, let's create some large tables to demonstrate:

```sql
-- Create a large 'orders' table
CREATE TABLE orders (
    order_id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id INT NOT NULL,
    product_id INT NOT NULL,
    order_date TIMESTAMP DEFAULT NOW(),
    quantity INT NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    status VARCHAR(50) NOT NULL
);

-- Insert 10 million rows
INSERT INTO orders (user_id, product_id, quantity, price, status)
SELECT
    floor(random() * 100000) + 1, -- 100k users
    floor(random() * 5000) + 1,  -- 5k products
    floor(random() * 10) + 1,
    round((random() * 100)::numeric, 2),
    (ARRAY['pending', 'completed', 'shipped', 'cancelled'])[floor(random() * 4) + 1]
FROM generate_series(1, 10000000) s;

-- Add an index that might be useful for some queries but won't stop a full scan
CREATE INDEX idx_orders_order_date ON orders (order_date);

-- Create a slightly smaller 'products' table for a join example
CREATE TABLE products (
    product_id INT PRIMARY KEY,
    category_id INT NOT NULL,
    product_name VARCHAR(100) NOT NULL,
    description TEXT
);

INSERT INTO products (product_id, category_id, product_name, description)
SELECT
    s,
    floor(random() * 100) + 1, -- 100 categories
    'Product ' || s,
    'Description for product ' || s
FROM generate_series(1, 5000) s;

-- Create an index on category_id for the products table
CREATE INDEX idx_products_category_id ON products (category_id);
```

Now, let's run a complex analytical query and see its plan. We'll reset `max_parallel_workers_per_gather` to illustrate the default or a low setting.

```sql
-- Disable parallelism temporarily for comparison (or set to a low value)
SET max_parallel_workers_per_gather = 0;
-- Or SET max_parallel_workers_per_gather = 2; for minimal parallelism

-- A query that sums quantities and counts orders for specific products,
-- joining with categories, over a recent period.
EXPLAIN ANALYZE
SELECT
    p.category_id,
    COUNT(o.order_id) AS total_orders,
    SUM(o.quantity) AS total_quantity_sold,
    AVG(o.price) AS avg_order_price
FROM
    orders o
JOIN
    products p ON o.product_id = p.product_id
WHERE
    o.order_date >= NOW() - INTERVAL '6 months'
    AND o.status = 'completed'
GROUP BY
    p.category_id
ORDER BY
    total_orders DESC
LIMIT 10;
```

If `max_parallel_workers_per_gather` is 0 or low, you'll likely see a plan dominated by sequential scans and single-process operations. The `EXPLAIN ANALYZE` output will *not* show `Gather` or `Parallel` nodes.

Now, let's enable parallelism and compare:

```sql
-- Restore or increase parallelism.
-- This tells the planner it can use up to 8 parallel workers for this specific query.
SET max_parallel_workers_per_gather = 8;

-- Also ensure global settings allow this (covered in the next section).
-- For this example, assume max_worker_processes and max_parallel_workers are high enough.

EXPLAIN ANALYZE
SELECT
    p.category_id,
    COUNT(o.order_id) AS total_orders,
    SUM(o.quantity) AS total_quantity_sold,
    AVG(o.price) AS avg_order_price
FROM
    orders o
JOIN
    products p ON o.product_id = p.product_id
WHERE
    o.order_date >= NOW() - INTERVAL '6 months'
    AND o.status = 'completed'
GROUP BY
    p.category_id
ORDER BY
    total_orders DESC
LIMIT 10;
```

**What to look for in `EXPLAIN ANALYZE` output (simplified):**

```
QUERY PLAN
----------------------------------------------------------------------------------------------------------------------------------------------------------------
Limit  (cost=... rows=... width=...) (actual time=... rows=... loops=1)
  ->  Sort  (cost=... rows=... width=...) (actual time=... rows=... loops=1)
        Sort Key: (count(o.order_id)) DESC
        Sort Method: top-N heapsort  Memory: ...kB
        ->  HashAggregate  (cost=... rows=... width=...) (actual time=... rows=... loops=1)
              Group Key: p.category_id
              Batches: 1  Memory Usage: ...kB
              ->  Gather  (cost=... rows=... width=...) (actual time=... rows=... loops=1)
                    Workers Planned: 8
                    Workers Launched: 8
                    ->  Hash Join  (cost=... rows=... width=...) (actual time=... rows=... loops=8)
                          Hash Cond: (o.product_id = p.product_id)
                          ->  Parallel Seq Scan on orders o  (cost=... rows=... width=...) (actual time=... rows=... loops=8)
                                Filter: ((o.order_date >= (now() - '6 mons'::interval)) AND ((o.status)::text = 'completed'::text))
                                Rows Removed by Filter: ...
                          ->  Hash  (cost=... rows=... width=...) (actual time=... rows=... loops=1)
                                ->  Seq Scan on products p  (cost=... rows=... width=...) (actual time=... rows=... loops=1)
```

Notice the key nodes:
*   `Gather`: This is the leader process collecting results from workers. The `Workers Planned` and `Workers Launched` indicate how many parallel workers were used.
*   `Parallel Seq Scan on orders o`: This tells you the `orders` table scan was distributed across workers.
*   `Hash Join` inside the `Gather`: This indicates the join operation itself was parallelized, likely a **parallel hash join**, where workers either build or probe parts of the hash table concurrently.

This robust approach doesn't just enable parallelism; it gives you the tools (`EXPLAIN ANALYZE`) to verify *if* it's happening and how effectively.

## Senior-level insights & gotchas

Enabling parallelism isn't a "set and forget" operation. There are nuances that can trip up even experienced engineers.

### Understanding `max_parallel_workers_per_gather`

This parameter defines the *maximum number of parallel workers that a single `Gather` or `Gather Merge` node can launch for a single query*. It's a query-specific limit, not a global one. A common misconception is that setting this high guarantees parallel execution. It doesn't. It just gives the planner *permission* to use up to that many workers *if it deems fit*.

This setting must also be supported by global parameters:
*   `max_worker_processes`: The total number of background worker processes the system can support, including parallel query workers, logical replication workers, etc. If this is too low, parallel queries might not get workers.
*   `max_parallel_workers`: The maximum number of parallel workers that can be running simultaneously across *all* queries in the entire system. If this is hit, new parallel queries will run with fewer workers or sequentially.

A typical configuration might be `max_worker_processes = 16`, `max_parallel_workers = 8`, and `max_parallel_workers_per_gather = 4`. This means the system can run 16 total background workers, up to 8 of which can be parallel query workers, and any *single query* can use up to 4 of those. Tuning this is a balancing act: too many workers can saturate CPU/I/O, too few leaves performance on the table.

### When parallelism is silently disabled

Even with optimal settings, the optimizer might choose not to parallelize.
*   **Small tables or low selectivity:** The database won't parallelize if the estimated cost of parallel execution (including worker startup overhead) is higher than sequential execution.
*   **Write-heavy DML or locking:** Queries inside `UPDATE` or `DELETE` statements are often not parallelized because coordinating writes and locks across multiple workers is complex and prone to deadlock. Queries using `FOR UPDATE` or `FOR SHARE` clauses can also limit parallelism.
*   **Transactions with certain isolation levels:** `SERIALIZABLE` or `REPEATABLE READ` transactions can sometimes restrict parallelism to ensure strict data consistency, although PostgreSQL has made strides here.
*   **Temporary tables and functions:** Some operations involving temporary tables or certain user-defined functions are not parallel-safe.
*   **Complexity (or lack thereof):** Very simple queries (e.g., `SELECT 1`) or queries only selecting a few rows from an index will run sequentially.
*   **I/O Bound Systems:** If your storage system cannot keep up with the data throughput, adding more parallel workers just makes them wait longer, leading to diminishing returns.
*   **Data Skew:** If one worker gets an incredibly unbalanced chunk of data (e.g., one partition contains 90% of the data due to a poorly chosen partitioning key), that worker becomes the bottleneck, negating the benefits of parallelism for the others. This is a common failure mode in distributed systems.

### The "sweet spot" for worker count

More workers don't always mean faster queries. Each worker consumes resources (CPU, memory, I/O bandwidth) and adds coordination overhead. Beyond a certain point, the overhead of managing workers can outweigh the benefits, leading to *slower* query execution. The optimal number depends heavily on your hardware, data size, query complexity, and concurrent workload. Often, 50-75% of your available physical CPU cores (or even fewer) is a good starting point for `max_parallel_workers_per_gather`, assuming your `max_parallel_workers` and `max_worker_processes` are set higher. Experimentation with `EXPLAIN ANALYZE` and real-world timings is critical.

### Monitoring is key

Don't guess. Use tools like `pg_stat_activity` to see active worker processes, `htop`/`atop` to monitor CPU and I/O usage during parallel queries, and Grafana dashboards to track long-term performance trends. Look for:
*   Are all your planned workers actually launching?
*   Is CPU utilization distributed across cores, or is one core still maxed out?
*   Are you hitting I/O bottlenecks (high `iowait`) even with parallelism?

## Summary & production checklist

Parallel query execution is a powerful tool to accelerate analytical workloads, but it requires careful configuration and understanding. Don't let your expensive hardware sit idle!

### Production checklist for parallel query optimization:

*   **Verify Parallelism with `EXPLAIN ANALYZE`:** Always check the query plan for `Gather`, `Gather Merge`, and `Parallel` nodes. If they're missing for a complex query, investigate why.
*   **Tune `max_parallel_workers_per_gather`:** Experiment with this session-level (or global) parameter. Start with 50-75% of your available CPU cores and adjust based on performance.
*   **Configure Global Parallel Settings:** Ensure `max_worker_processes` and `max_parallel_workers` are set high enough in `postgresql.conf` to allow the desired number of parallel workers across the entire system.
*   **Identify Parallelism Anti-Patterns:** Avoid enabling or expecting parallelism for OLTP queries, small datasets, or queries known to be I/O bound.
*   **Monitor Resource Usage:** Use OS tools (`htop`, `atop`) and database statistics (`pg_stat_activity`, `pg_stat_statements`) to observe CPU, memory, and I/O during parallel query execution. Look for bottlenecks.
*   **Watch for Data Skew:** Analyze your data distribution. Heavily skewed data can lead to unbalanced worker loads, diminishing parallel gains. Consider repartitioning or redesigning queries if this is an issue.
*   **Test on Realistic Data:** Always test performance changes on production-like data volumes and server loads. What works on a small dev instance may break in production.
