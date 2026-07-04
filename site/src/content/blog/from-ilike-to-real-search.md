---
title: "From ILIKE '%query%' to search that feels instant"
description: "LIKE queries work fine until your table grows. The real path from a slow sequential scan to search that returns results as you type."
pubDate: 2026-06-06
tags: ["postgresql", "search", "backend", "performance"]
category: "backend"
aiAssisted: false
readingTime: 5
---

Almost every project starts search the same way:

```sql
SELECT * FROM listings WHERE title ILIKE '%' || $1 || '%';
```

It works. It's also a full sequential scan on every keystroke, because a leading wildcard makes a B-tree index useless — Postgres can't binary-search for "somewhere in this string," so it has to read every row. At a few hundred rows this is invisible. At tens of thousands, it's the query users notice.

## Step one: Postgres full-text search

Before reaching for external infrastructure, Postgres already has a real search engine built in. `tsvector` and `tsquery` handle stemming, ranking, and stop words, and — critically — they're indexable with GIN.

```sql
ALTER TABLE listings ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || description)) STORED;

CREATE INDEX listings_search_idx ON listings USING GIN (search_vector);
```

```sql
SELECT * FROM listings
WHERE search_vector @@ plainto_tsquery('english', $1)
ORDER BY ts_rank(search_vector, plainto_tsquery('english', $1)) DESC;
```

This alone took one project's search from full scans to indexed lookups and cut query times by roughly 40%. It handles "developer" matching "developing," ranks better matches higher, and costs nothing extra to run — it's already in the database you have.

## Where full-text search stops being enough

`tsvector` is good at "does this document match this query." It's not built for the things product teams ask for next: typo tolerance ("pyton" finding "python"), faceted filtering combined with relevance ranking, or sub-50ms response times against a search-as-you-type UI with 100k+ records. You can bolt some of this onto Postgres with `pg_trgm` for fuzzy matching, but at some point you're reimplementing a search engine inside your primary database — the same database handling your writes and transactions.

## Step two: a dedicated search engine

This is where something like Typesense earns its place. Point it at your existing table, define which fields are searchable versus filterable, and it handles typo tolerance and ranking out of the box, with response times that stay flat as the dataset grows because it's built around an in-memory index designed for exactly this.

```json
{
  "name": "listings",
  "fields": [
    { "name": "title", "type": "string" },
    { "name": "description", "type": "string" },
    { "name": "price", "type": "int32", "facet": true },
    { "name": "city", "type": "string", "facet": true }
  ],
  "default_sorting_field": "price"
}
```

Indexing 10,000+ records and querying against them is where the difference from `ILIKE` becomes obvious — not a 40% improvement, but search that returns results before the user finishes typing, with faceted filters on price and location computed in the same request.

## The part that's easy to get wrong

Search infrastructure is a read replica of the truth, not the source of it. Every write path that touches searchable fields needs to also update the search index — and needs a plan for what happens when that second write fails. A queued reindex job with retries is the boring, correct answer; synchronously indexing inside the same request as the database write is the version that looks fine in testing and quietly drifts in production the first time the search service has a bad minute.

## Picking a level

- **A few thousand rows, simple matching**: `ILIKE` with a trigram index (`pg_trgm`) is honestly fine.
- **Tens of thousands of rows, need ranking**: Postgres full-text search. Free, indexed, already there.
- **Real search UX — typo tolerance, facets, instant results, growing dataset**: a dedicated engine like Typesense or Elasticsearch, with an explicit reindexing pipeline.

Don't reach for step three to solve step one's problem. The database you already run can carry search a lot further than most teams assume.
