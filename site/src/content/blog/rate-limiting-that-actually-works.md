---
title: Rate Limiting That Actually Works
description: >-
  Stop outages and protect your APIs. Learn the critical differences between
  token bucket and sliding window algorithms, and how to build a distributed…
pubDate: '2026-10-05'
tags:
  - rate-limiting
  - system-design
  - redis
  - go
  - api-gateway
category: system-design
draft: false
aiAssisted: true
readingTime: 14
linkedinHook: >-
  Your production systems are running without the right rate limiter, and it's a
  ticking time bomb. Here's how to build one that genuinely protects.
linkedinBody: >-
  I just wrote about designing rate limiters that actually work, especially in
  distributed environments. It covers critical algorithm choices, implementing
  with Redis Lua for atomic operations, and where to place limits in your
  architecture.
---
## Introduction & Hook

Picture this: it's 3 AM. Your pager screams. Production is down. A brand new integration partner just launched, and their "small test" unleashed a thundering herd of requests, overwhelming your API, flooding your database, and cascading into a full-blown outage. The problem? Your existing rate limiter, if you even had one, simply crumpled under the pressure. It was an in-memory relic, or worse, a set of fire-and-forget `GET` and `SET` calls to Redis that race conditions gleefully skipped past.

This isn't just about preventing bad actors. It's about fundamental system stability. Unchecked traffic, whether accidental or malicious, chokes services, exhausts precious compute resources, and leads to unacceptable downtime. This is where **rate limiting** becomes your system's indispensable bouncer, traffic cop, and bodyguard all rolled into one. It’s the mechanism that controls how many requests a client, IP address, or user can make to your service within a given timeframe, ensuring fair usage and protecting your infrastructure from overload.

## How it Works (The Visual Example)

Imagine your API endpoint as a busy toll booth on a highway. Trucks (requests) are constantly arriving. Without any control, they'd just pile up, blocking the road for everyone. A rate limiter acts as that toll booth operator, enforcing rules.

Let's look at two primary "rulebooks" for our operator:

1.  **Token Bucket**: Our toll booth has a special bucket. Every second, a new "token" (permission to pass) is added to the bucket, up to a maximum capacity. When a truck arrives, it tries to grab a token. If there's a token, the truck passes. If the bucket is empty, the truck is turned away.
    *   **Visual**: Think of a physical bucket with a hole at the bottom (tokens drip out, refilling). You can only pull a token if it's there. This allows for *bursts* of traffic (if the bucket is full) but strictly limits the *average* rate.
    *   **Scenario**: If your limit is 10 requests per second with a bucket size of 60, a client can make 60 requests instantly, then has to wait 6 seconds for the bucket to refill before making another 60.

2.  **Sliding Window (Counter or Log)**: This approach is less about "tokens" and more about "recent history."
    *   **Sliding Window Log**: The operator keeps a precise logbook of every truck that passed in the last minute. When a new truck arrives, the operator quickly flips through the log, removes any entries older than 60 seconds, and then counts how many trucks are left. If that count is under the limit, the new truck's time is added to the log, and it passes. If not, it's denied.
        *   **Visual**: A constantly updating spreadsheet. Accurate, but imagine writing down *every* truck's timestamp. Can get hefty.
    *   **Sliding Window Counter**: This is a more efficient, slightly less precise variant. Instead of individual timestamps, the operator maintains two counters: one for the current 60-second window and one for the *previous* 60-second window. When a truck arrives, the operator calculates a weighted average of these two counters (e.g., if the current window is 30% complete, then 30% of the previous window's count plus the current window's count). If this weighted sum is below the limit, the truck passes, and the current window's counter increments.
        *   **Visual**: Two chalkboards for two windows. The amount on the 'previous' board gradually fades out as the 'current' board fills up. This prevents bursts from resetting every window, but a sudden burst at the window boundary can still be an issue.

Each method has its strengths and weaknesses regarding burst handling, accuracy, and resource consumption. The choice depends entirely on your system's specific needs.

## Real-world Use Cases

Rate limiting is not a "nice-to-have"; it's a fundamental pillar of resilient system design.

**Where it's a lifesaver:**

*   **API Protection**: Your public API endpoints are prime targets. Rate limiting prevents malicious denial-of-service (DoS) attacks, brute-force attempts on login screens, and partner integrations from overwhelming your backend.
*   **Resource Throttling**: If certain user actions trigger expensive database queries, computationally intensive tasks, or third-party service calls (which often have their own rate limits!), applying a rate limit ensures you don't exhaust your own resources or incur massive unexpected bills.
*   **Fair Usage**: For multi-tenant applications or SaaS products, rate limits ensure one heavy user doesn't degrade performance for everyone else. It's like ensuring every kid gets a fair turn on the playground swing.
*   **Preventing Scraping**: Bots trying to scrape data from your site can be deterred by strict rate limits, making their efforts economically unfeasible.

**Where it becomes an anti-pattern (or needs careful consideration):**

*   **Internal, Trusted Services**: Applying strict rate limits between tightly coupled, trusted internal microservices can introduce unnecessary latency and create artificial bottlenecks. Often, here you'd prefer backpressure (e.g., queuing requests) or auto-scaling.
*   **Latency-Sensitive Operations**: For highly critical, real-time data flows where even a millisecond of artificial delay is unacceptable, an outright denial from a rate limiter might be the wrong choice. The focus should instead be on extreme horizontal scalability.
*   **Batch Processing**: Large data imports or batch jobs aren't about individual requests but bulk operations. Rate limiting per request here misses the point; you might need limits on job concurrency or overall throughput instead.

## Implementation & Code

A naive rate limiter often starts as an in-memory counter. This works fine for a single process but instantly breaks when you scale horizontally. Two instances mean double the allowed requests.

Let's illustrate with Go, contrasting a broken naive approach with a robust, distributed solution using Redis and Lua. We'll use the **Sliding Window Log** algorithm for its precision.

### The Naive, Broken Approach (In-memory)

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

// NaiveRateLimiter is an in-memory, single-instance rate limiter.
// It will fail catastrophically in a distributed environment.
type NaiveRateLimiter struct {
	mu      sync.Mutex // Protects access to counts and timestamps
	requests map[string][]time.Time
	limit   int
	window  time.Duration
}

func NewNaiveRateLimiter(limit int, window time.Duration) *NaiveRateLimiter {
	return &NaiveRateLimiter{
		requests: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
	}
}

// Allow checks if a request is allowed based on the in-memory log.
// This is NOT safe for distributed systems.
func (rl *NaiveRateLimiter) Allow(key string) bool {
	rl.mu.Lock() // Local lock, but does nothing for multiple instances
	defer rl.mu.Unlock()

	now := time.Now()
	
	// Filter out requests older than the window
	var recentRequests []time.Time
	for _, t := range rl.requests[key] {
		if now.Sub(t) <= rl.window {
			recentRequests = append(recentRequests, t)
		}
	}
	rl.requests[key] = recentRequests

	// Check if the current count exceeds the limit
	if len(rl.requests[key]) < rl.limit {
		rl.requests[key] = append(rl.requests[key], now) // Add current request
		return true
	}
	return false
}

func main() {
	limiter := NewNaiveRateLimiter(5, time.Second) // 5 requests per second

	fmt.Println("--- Naive Rate Limiter Simulation (Single Instance) ---")
	for i := 0; i < 10; i++ {
		key := "user:123"
		if limiter.Allow(key) {
			fmt.Printf("Request %d for %s: ALLOWED\n", i+1, key)
		} else {
			fmt.Printf("Request %d for %s: DENIED\n", i+1, key)
		}
		time.Sleep(150 * time.Millisecond) // Simulate varying request intervals
	}
	// On a single instance, this works. But if you have 10 instances, this allows 50 requests/sec.
}
```

This `NaiveRateLimiter` uses a local `sync.Mutex` to protect its `map`. On a single server, it behaves correctly. But deploy this across multiple instances behind a load balancer, and each instance maintains its *own* request log. A client making 5 requests to instance A and 5 to instance B in the same second would get 10 requests through, violating the 5 req/sec limit. This is a classic distributed systems failure.

### The Robust, Distributed Approach (Redis + Lua Script)

To achieve true distributed rate limiting, we need a shared, atomic state. **Redis** is a fantastic choice, and its ability to execute **Lua scripts atomically** is the secret sauce. A Lua script executes as a single, uninterruptible operation on the Redis server, eliminating race conditions.

We'll use a Redis **Sorted Set (`ZSET`)** to store timestamps for each request. The score and member will both be the request's timestamp (in milliseconds).

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/go-redis/redis/v8" // Using redis/v8 client
)

// RedisRateLimiter implements a distributed sliding window log using Redis Lua.
type RedisRateLimiter struct {
	client *redis.Client
	script *redis.Script
	limit  int // Max requests
	window int // Window duration in milliseconds
}

// luaScript is the core logic for the sliding window log.
// KEYS[1]: The key for the ZSET (e.g., "rate_limit:user:123")
// ARGV[1]: Window duration in milliseconds
// ARGV[2]: Max requests allowed in the window
// ARGV[3]: Current timestamp in milliseconds
var luaScript = redis.NewScript(`
	local key = KEYS[1]
	local window_ms = tonumber(ARGV[1])
	local limit = tonumber(ARGV[2])
	local current_time_ms = tonumber(ARGV[3])

	local window_start_ms = current_time_ms - window_ms

	-- Remove timestamps older than the window (atomic operation)
	redis.call('ZREMRANGEBYSCORE', key, 0, window_start_ms)

	-- Get the current count of requests in the window
	local count = redis.call('ZCARD', key)

	if count < limit then
		-- If under limit, add the current timestamp and set a TTL (atomic)
		redis.call('ZADD', key, current_time_ms, current_time_ms)
		redis.call('EXPIRE', key, math.ceil(window_ms / 1000) + 1) -- Set TTL for the key
		return 1 -- Allowed
	else
		return 0 -- Denied
	end
`)

func NewRedisRateLimiter(client *redis.Client, limit int, windowMs int) *RedisRateLimiter {
	return &RedisRateLimiter{
		client: client,
		script: luaScript,
		limit:  limit,
		window: windowMs,
	}
}

// Allow checks if a request is allowed using the Redis Lua script.
func (rl *RedisRateLimiter) Allow(ctx context.Context, key string) (bool, error) {
	// Execute the Lua script atomically on Redis
	res, err := rl.script.Run(ctx, rl.client,
		[]string{key}, // KEYS
		rl.window,     // ARGV[1]: window_ms
		rl.limit,      // ARGV[2]: limit
		time.Now().UnixMilli(), // ARGV[3]: current_time_ms
	).Result()

	if err != nil {
		return false, fmt.Errorf("redis script error: %w", err)
	}

	// The Lua script returns 1 for allowed, 0 for denied
	allowed := res.(int64) == 1
	return allowed, nil
}

func main() {
	ctx := context.Background()

	// Initialize Redis client
	rdb := redis.NewClient(&redis.Options{
		Addr:     "localhost:6379", // Use your Redis address
		Password: "",               // No password
		DB:       0,                // Default DB
	})

	// Test Redis connection
	_, err := rdb.Ping(ctx).Result()
	if err != nil {
		log.Fatalf("Could not connect to Redis: %v", err)
	}
	fmt.Println("Connected to Redis!")

	limiter := NewRedisRateLimiter(rdb, 5, 1000) // 5 requests per second (1000ms window)

	fmt.Println("\n--- Redis Distributed Rate Limiter Simulation ---")
	for i := 0; i < 15; i++ {
		key := "api:user:456" // This key identifies the entity being rate limited
		allowed, err := limiter.Allow(ctx, key)
		if err != nil {
			log.Printf("Error checking rate limit: %v", err)
			time.Sleep(100 * time.Millisecond) // Don't hammer on error
			continue
		}

		if allowed {
			fmt.Printf("Request %d for %s: ALLOWED\n", i+1, key)
		} else {
			fmt.Printf("Request %d for %s: DENIED\n", i+1, key)
		}
		time.Sleep(150 * time.Millisecond) // Simulate traffic
	}

	// Wait for a second and try again to show limit reset
	time.Sleep(time.Second * 1)
	fmt.Println("\n--- After a delay (window reset) ---")
	for i := 0; i < 3; i++ {
		key := "api:user:456"
		allowed, err := limiter.Allow(ctx, key)
		if err != nil {
			log.Printf("Error checking rate limit: %v", err)
			continue
		}
		if allowed {
			fmt.Printf("Request %d for %s: ALLOWED\n", i+1, key)
		} else {
			fmt.Printf("Request %d for %s: DENIED\n", i+1, key)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
```

**Why this code works:**

*   **Atomicity with Lua**: The entire `luaScript` executes on the Redis server without interruption. There's no window for a race condition between checking the count and adding a new timestamp, which is critical for distributed correctness.
*   **Sorted Set (`ZSET`)**: `ZADD` adds timestamps as members with their own timestamp as the score. `ZREMRANGEBYSCORE` efficiently removes all old entries in a single operation. `ZCARD` quickly counts the remaining elements.
*   **Key Design**: The `key` (e.g., `api:user:456`) clearly identifies *what* is being rate-limited. This could be an IP address, a user ID, an API key, or even a specific endpoint.
*   **TTL**: `EXPIRE` ensures that even if a key becomes inactive, Redis will eventually clean it up, preventing unbounded memory growth from dormant keys. We add 1 second to `window_ms / 1000` to ensure the key doesn't expire before its window is fully processed.

## Senior-Level Insights & Gotchas

Congratulations, you've built a functional distributed rate limiter. Now, let's talk about the nuances that trip up even experienced engineers.

### Token Bucket vs. Sliding Window: Choosing Wisely

*   **Token Bucket**: If your goal is to allow *bursts* of traffic while strictly enforcing an *average* rate over time, Token Bucket is your friend. It's often simpler to implement in a truly distributed fashion (e.g., each request consumes a token, and a separate background process replenishes the bucket). However, a large bucket size can mask abuse for a short period.
*   **Sliding Window Log**: This is the most accurate. It perfectly reflects the request rate within the defined window, regardless of when requests arrive. It's excellent for preventing sudden, concentrated bursts. The downside is memory usage (storing every timestamp) and slightly higher computational cost in Redis (though `ZREMRANGEBYSCORE` is efficient). Our Redis Lua example uses this.
*   **Sliding Window Counter**: A good compromise. More memory-efficient than the log and generally better at preventing "edge case" bursts than fixed windows (where a client could send `limit` requests at the very end of window A and `limit` requests at the very start of window B, doubling the actual limit for a brief period). It's trickier to implement atomically in Redis without Lua.

No single algorithm is perfect. Most serious systems use a hybrid, often Token Bucket at the gateway and Sliding Window (or another Token Bucket) at the application level.

### Placement: Gateway vs. Application-Level Limits

This isn't an either/or choice; it's a "yes, and..." situation.

*   **Gateway/Proxy-Level (e.g., Nginx, Envoy, AWS API Gateway)**:
    *   **Pros**: First line of defense. Protects *all* backend services. Filters bad traffic before it consumes your application's resources. Excellent for coarse-grained limits (IP address, API key).
    *   **Cons**: Less granular. Hard to enforce limits based on complex business logic (e.g., "user can only update their profile 3 times an hour").
*   **Application-Level**:
    *   **Pros**: Highly granular. Can enforce limits based on user IDs, specific endpoint actions, resource impact (e.g., "max 10 heavy database queries per minute per user"). Integrates deeply with your application's logic.
    *   **Cons**: Traffic hits your application first, consuming *some* resources. Requires more development effort.

**Best Practice**: Implement coarse-grained limits at the **gateway** to protect your entire infrastructure from overwhelming traffic. Then, add fine-grained, business-logic-driven limits at the **application level** for specific, high-value, or resource-intensive operations.

### Gotchas and Advanced Considerations

*   **Time Synchronization**: In distributed systems, relying on `time.Now()` for timestamps needs caution. Small clock skews between application servers and Redis can lead to slight inaccuracies. Ensure your systems are synchronized (e.g., with NTP).
*   **Redis Latency**: While Redis is fast, every network hop adds latency. For extremely high-throughput, low-latency applications, evaluate the overhead. Consider optimizing by sending multiple requests in a single round trip if possible (though Lua already optimizes this for the limit check).
*   **Throttling vs. Denying**: Sometimes denying a request (HTTP 429 Too Many Requests) isn't ideal. Consider **backpressure** or queuing mechanisms for internal services or non-critical asynchronous tasks.
*   **Graceful Degradation**: What happens when your Redis cluster goes down? Does your rate limiter become an open floodgate, or does it fail-open/fail-closed in a controlled manner? Design for this. A fail-open might temporarily allow too much traffic but prevent a complete system outage caused by the limiter itself.
*   **Monitoring**: This is non-negotiable. Monitor "requests allowed," "requests denied," and "rate limiter latency" at every layer. Alert when denial rates are too high (indicating abuse or misconfigured limits) or too low (indicating your limiter isn't working).

## Summary & Production Checklist

Designing a rate limiter that *actually* works is a blend of algorithmic understanding, distributed systems patterns, and careful architectural choices. It's not just a feature; it's a foundational resilience primitive.

**Your Production Checklist:**

*   **Choose the right algorithm**:
    *   **Token Bucket** for allowing bursts while maintaining average rate.
    *   **Sliding Window Log** for precise control over a rolling window and strict burst prevention.
    *   **Sliding Window Counter** as a more efficient, good-enough alternative.
*   **Go Distributed**: Use a shared, atomic store like Redis with Lua scripts to prevent race conditions and ensure consistent limits across all instances.
*   **Layer your limits**: Implement coarse-grained limits at the **gateway** (IP, API key) and fine-grained, business-logic-driven limits at the **application level** (user ID, specific actions).
*   **Handle denials gracefully**: Return `HTTP 429 Too Many Requests` with a `Retry-After` header.
*   **Monitor everything**: Track allowed/denied requests, latency added by the limiter, and set up alerts for anomalies.
*   **Design for failure**: What happens if your Redis goes down? Implement a fail-open or fail-closed strategy.
*   **Test under load**: Simulate traffic spikes and measure your limiter's effectiveness and its impact on system performance.
