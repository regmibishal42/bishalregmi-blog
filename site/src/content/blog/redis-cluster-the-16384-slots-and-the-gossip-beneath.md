---
title: 'Redis Cluster: The 16384 Slots and the Gossip Beneath'
description: >-
  A deep dive into Redis Cluster's internals: hash slots, gossip protocol,
  resharding, MOVED/ASK redirects, and failover mechanics.
pubDate: '2026-07-04'
tags:
  - redis
  - cluster
  - distributed-systems
  - high-availability
  - caching
category: redis
draft: false
aiAssisted: true
readingTime: 21
---
The `MOVED` redirect error. It's a phrase that can send a shiver down the spine of even seasoned backend engineers. Perhaps you've scaled out a monolithic Redis instance to a cluster, deployed your client, and then, inexplicably, requests start failing with `(error) MOVED 12345 10.0.0.2:6379`. Your client *should* be cluster-aware, yet the logs fill with these cryptic messages. Digging deeper, you might find yourself pondering the number **16384**. Not 2^14, not 2^15, but specifically 16384. This seemingly arbitrary constant underpins the entire sharding strategy of Redis Cluster, dictating everything from how your data is distributed to the very messages nodes whisper to each other across the cluster bus. Understanding *why* 16384, and how Redis Cluster nodes leverage it with a touch of distributed democracy, is key to navigating the waters of high-scale, resilient caching.

## Mental model

At its core, Redis Cluster exists to solve the problem of scaling beyond a single Redis instance's capacity. A standalone Redis server, while blazingly fast, is ultimately limited by the resources of a single machine: RAM, CPU, and network bandwidth. To truly scale, you need to distribute your data and operations across multiple machines.

### Hash slots

Imagine you have 16,384 numbered mailboxes, and each Redis server in your cluster is assigned a specific range of these mailboxes to look after. When you want to store a new letter (your data), you first figure out which mailbox number it belongs to, and then you send it to the server that's responsible for that particular mailbox.

This is exactly what **hash slots** are for. In Redis Cluster, instead of directly mapping keys to servers, keys are first mapped to one of **16384 hash slots**. Each master node in the cluster is responsible for a subset of these slots. The mapping from key to slot is deterministic: `CRC16(key) % 16384`. The `CRC16-CCITT` algorithm (specifically the 0x1021 polynomial variant, as found in `src/crc16.c` in the Redis source) ensures a reasonably uniform distribution of keys across the slots. The brilliance of this approach is that adding or removing nodes, or redistributing data, only involves reassigning slots, not re-hashing every key against a changing number of nodes.

### Gossip protocol

Think of the servers in your cluster like a group of office workers constantly chatting amongst themselves. They share casual updates about who's doing what, if anyone seems busy or unresponsive, and if any new project assignments (slot ownership changes) have come down from management. If enough workers independently notice that someone has been quiet for too long, they collectively agree that person is likely out of the office.

This informal, peer-to-peer communication is the **gossip protocol** at work. Redis Cluster nodes communicate over a dedicated **cluster bus**, which is a separate TCP port (typically the client port + 10000, e.g., 6379 -> 16379). Nodes periodically send small **PING** messages to a subset of other known nodes. These PINGs contain a node's view of the cluster state: its own unique **Node ID** (a 40-character hexadecimal string), its IP and port, its current **config epoch**, its flags (master/slave, connected/disconnected), and a snapshot of a few other nodes it knows about, including any **PFAIL** (Probable Fail) flags for nodes it suspects are down. This eventual consistency model allows all nodes to gradually converge on a shared, consistent view of the cluster's topology and health without requiring a centralized coordinator.

### Failover mechanics

If a master server (the one directly responsible for a set of mailboxes) suddenly goes silent, its dedicated assistant (a replica) steps up. This assistant then announces to the rest of the cluster, through the gossip network, that it's now taking over all the mailboxes the original server was managing.

This describes Redis Cluster's **failover mechanics**. Nodes detect potential failures by setting a **PFAIL** flag for other nodes if they don't receive PONG replies within `cluster-node-timeout`. If a majority of *master* nodes in the cluster agree that a particular master is in a PFAIL state, they collectively mark it as **FAIL**. Once a master is marked FAIL, its replicas initiate an election process (a simplified, Paxos-like consensus, similar in spirit to Raft). The replica with the most up-to-date information (highest **config epoch**) wins the election, promotes itself to master, and broadcasts its new role and slot ownership to the rest of the cluster via the gossip protocol. This ensures high availability for the slots previously managed by the failed master.

## How it actually works

Let's pull back the curtain and peek at the underlying machinery.

### The 16384 hash slots: a pragmatic choice

The choice of **16384 slots** is often a point of curiosity. Why not a power of two like 8192 or 32768? As Salvatore Sanfilippo (Antirez), the creator of Redis, explained, it's a trade-off. Each Redis Cluster node needs to broadcast its slot configuration to other nodes via the gossip protocol. This slot map is represented as a **bitmap**. With 16384 slots, the bitmap is exactly `16384 bits / 8 bits/byte = 2048 bytes`, or 2KB. This small footprint means that advertising the state of a node costs a mere 2KB of data, which is efficient enough for frequent exchange over the cluster bus. If the number of slots were much larger (e.g., 1 million), the bitmap size would become prohibitive for efficient gossip. Conversely, if there were too few slots (e.g., 256), the granularity of resharding would be too coarse, making it difficult to balance the load evenly across many nodes. 16384 hits a sweet spot for both network efficiency and flexible distribution. Each node maintains a `clusterState->slots` array, which points to the `clusterNode` struct responsible for each slot.

### MOVED vs. ASK redirects: graceful transitions

When a client connects to a Redis Cluster, it should ideally build and maintain a map of which slots are owned by which nodes. However, cluster topology changes (resharding, failovers), and the client's map can become stale. This is where redirects come into play.

*   **MOVED Redirects:**
    *   *Plain English:* "You've sent your letter to the wrong permanent address. From now on, send all letters for this mailbox number to server X." The client updates its address book.
    *   *Deep Dive:* When a client sends a command for a key, and that key's slot is no longer owned by the target node, the node responds with a `MOVED <slot> <ip>:<port>` error. For example, `(error) MOVED 8675 192.168.1.5:6379`. The client *must* update its internal slot-to-node mapping for that specific slot (and potentially refresh its entire map) and then re-execute the command on the indicated target node. `MOVED` signifies a permanent change in slot ownership.
*   **ASK Redirects:**
    *   *Plain English:* "This specific mailbox is currently being moved, so some letters are still here, but some are already at server Y. For *this particular letter*, please temporarily go ask server Y, but don't change your address book yet because I might still get other letters for this mailbox."
    *   *Deep Dive:* **ASK redirects** occur exclusively during **resharding**. When a slot `S` is being migrated from a source node to a destination node, the source node is in a `MIGRATING` state for `S`, and the destination node is in an `IMPORTING` state for `S`.
        *   If a client requests a key for slot `S` on the source node, and that key has *already* been migrated, the source node sends a `MOVED` redirect.
        *   If the client requests a key for slot `S` on the source node, and that key has *not yet* been migrated, the source node responds with `ASK <slot> <ip>:<port>`. The client is then expected to send an `ASKING` command *followed immediately by the original command* to the destination node. The `ASKING` command is a one-time "pass" that tells the destination node to accept the subsequent command for an `IMPORTING` slot, bypassing its usual redirection logic. Crucially, the client does *not* update its slot map permanently after an `ASK` redirect. It's a temporary measure for a single command.

### Hash tags: co-locating data

*   *Plain English:* Sometimes, you want all the pieces of information related to a single entity (like a user's profile, orders, and preferences) to always end up in the same mailbox, even if those pieces of information have slightly different names. **Hash tags** let you put a special label on your data so the system knows to keep them together.

*   *Deep Dive:* Redis Cluster uses the `CRC16` hash function on the *entire* key by default. However, if a key contains a substring enclosed in `{}` characters, only the substring *inside* the first pair of curly braces is used for hashing. For example, `user:{123}:profile` and `user:{123}:orders` will both hash to the same slot because only `123` is considered for the CRC16 calculation. This is invaluable for **multi-key operations** (e.g., `MSET`, `SUNION`, Lua scripts) that *require* all involved keys to reside on the same logical node. Without hash tags, such operations would likely result in a `CROSSSLOT` error.

### Resharding: moving the goalposts (and the data)

*   *Plain English:* Resharding is the process of intelligently rearranging which servers are responsible for which mailboxes, and then physically moving all the letters (data) from the old server to the new one, all without interrupting the mail service.

*   *Deep Dive:* Resharding in Redis Cluster is an online operation, meaning the cluster remains available during the process. It's typically orchestrated by the `redis-cli --cluster reshard` command. The high-level steps are:
    1.  **Preparation:** Identify the source node(s), destination node(s), and the specific slots to migrate.
    2.  **Marking Slots:** The `redis-cli` tool sends `CLUSTER SETSLOT <slot> MIGRATING <destination_node_id>` to the source node and `CLUSTER SETSLOT <slot> IMPORTING <source_node_id>` to the destination node. This sets up the temporary `ASK` redirect behavior.
    3.  **Key Migration:** The `redis-cli` client then iteratively requests keys from the source node using `CLUSTER GETKEYSINSLOT <slot> <count>` and moves them to the destination node using the `MIGRATE` command (`MIGRATE <destination_ip> <destination_port> <key> <destination_db> <timeout>`). `MIGRATE` is atomic; it moves a key, its TTL, and associated data from source to destination in a single blocking operation.
    4.  **Client Redirection During Migration:** As explained above, clients are either `MOVED` (if a key has already been migrated or if the client tries to write to a non-existent key on the source) or `ASKed` (if a key still resides on the `MIGRATING` source node).
    5.  **Finalization:** Once all keys in a slot are moved, `redis-cli` sends `CLUSTER SETSLOT <slot> NODE <destination_node_id>` to *all* nodes in the cluster. This command updates their slot maps, making the change permanent and completing the migration for that slot. This process is repeated for every slot being moved.

## Code

Interacting with Redis Cluster requires a client that understands the redirection protocol. Here's a Go example demonstrating the difference between using unrelated keys and using hash tags for multi-key operations.

```go
package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

func main() {
	ctx := context.Background()

	// In a production environment, list multiple seed nodes for resilience.
	// These are typically your master nodes.
	rdb := redis.NewClusterClient(&redis.ClusterOptions{
		Addrs: []string{"127.0.0.1:7000", "127.0.0.1:7001", "127.0.0.1:7002"}, // Example cluster nodes
	})

	_, err := rdb.Ping(ctx).Result()
	if err != nil {
		fmt.Printf("Error connecting to Redis Cluster: %v\n", err)
		return
	}
	fmt.Println("Successfully connected to Redis Cluster.")

	// --- Naive approach: keys without hash tags ---
	// These keys will likely hash to different slots across the cluster.
	fmt.Println("\n--- Naive Approach (Potential CROSSSLOT for atomic ops) ---")
	err1 := rdb.Set(ctx, "user_profile:123", "John Doe Profile", 0).Err()
	err2 := rdb.Set(ctx, "user_orders:123", "John Doe Orders", 0).Err()

	if err1 != nil || err2 != nil {
		fmt.Printf("Error setting naive keys: %v, %v\n", err1, err2)
	}

	// Attempting a raw MGET on keys in different slots would yield a CROSSSLOT error.
	// The `go-redis` client library often mitigates this by internally splitting MGET
	// into multiple GET requests, but this loses atomicity and is not universally true for
	// all multi-key commands (e.g., Lua scripts or set intersections).
	fmt.Printf("Attempting MGET on 'user_profile:123' and 'user_orders:123':\n")
	resultsNaive, err := rdb.MGet(ctx, "user_profile:123", "user_orders:123").Result()
	if err != nil {
		// If you were running a raw Redis CLI MGET command against a node
		// and the keys were on different slots, this would be a CROSSSLOT error.
		// go-redis handles it gracefully by splitting, but the point stands.
		fmt.Printf("MGET failed (client-side mitigation possible, but not atomic): %v\n", err)
	} else {
		fmt.Printf("MGET results (possibly from split requests): %v\n", resultsNaive)
	}


	// --- Better approach: using hash tags for co-location ---
	// Keys with the same hash tag (e.g., {user123}) are guaranteed to land on the same slot.
	fmt.Println("\n--- Better Approach (using Hash Tags for co-location) ---")
	userID := "456" // This acts as our hash tag
	profileKey := fmt.Sprintf("user:{%s}:profile", userID)
	ordersKey := fmt.Sprintf("user:{%s}:orders", userID)

	err1 = rdb.Set(ctx, profileKey, "Jane Doe Profile", 0).Err()
	err2 = rdb.Set(ctx, ordersKey, "Jane Doe Orders", 0).Err()

	if err1 != nil || err2 != nil {
		fmt.Printf("Error setting hash-tagged keys: %v, %v\n", err1, err2)
	}

	// Now, MGET (and other atomic multi-key operations or Lua scripts)
	// will work reliably as both keys are on the same node.
	fmt.Printf("Attempting MGET on hash-tagged keys '%s' and '%s':\n", profileKey, ordersKey)
	resultsTagged, err := rdb.MGet(ctx, profileKey, ordersKey).Result()
	if err != nil {
		// This error is highly unlikely if hash tags are used correctly.
		fmt.Printf("MGET on hash-tagged keys failed unexpectedly: %v\n", err)
	} else {
		fmt.Printf("MGET results (atomic and successful): %v\n", resultsTagged)
	}

	// Demonstrate a Lua script needing keys on the same slot
	fmt.Println("\n--- Lua Script with Hash Tags for atomicity ---")
	luaScript := `
		redis.call('SET', KEYS[1], ARGV[1])
		redis.call('SET', KEYS[2], ARGV[2])
		return 'OK'
	`
	scriptKeys := []string{fmt.Sprintf("user:{%s}:name", userID), fmt.Sprintf("user:{%s}:email", userID)}
	scriptArgs := []interface{}{"Alice", "alice@example.com"}

	fmt.Printf("Executing Lua script for keys '%s' and '%s':\n", scriptKeys[0], scriptKeys[1])
	res, err := rdb.Eval(ctx, luaScript, scriptKeys, scriptArgs...).Result()
	if err != nil {
		// Without hash tags, this Lua script would likely error with CROSSSLOT if keys differed.
		fmt.Printf("Lua script failed: %v\n", err)
	} else {
		fmt.Printf("Lua script executed successfully: %v\n", res)
		fmt.Printf("Key '%s': %s\n", scriptKeys[0], rdb.Get(ctx, scriptKeys[0]).Val())
		fmt.Printf("Key '%s': %s\n", scriptKeys[1], rdb.Get(ctx, scriptKeys[1]).Val())
	}

	// Clean up (optional, giving replication a moment)
	time.Sleep(100 * time.Millisecond)
	rdb.Del(ctx, "user_profile:123", "user_orders:123", profileKey, ordersKey, scriptKeys[0], scriptKeys[1]).Err()
}
```

The **WHY** here is critical: for true atomic multi-key operations or Lua scripts, Redis *requires* all participating keys to reside on the same node. The naive approach, where keys like `"user_profile:123"` and `"user_orders:123"` are likely to hash to different slots, would cause such operations to fail with a `CROSSSLOT` error. While some modern client libraries (like `go-redis` shown) might transparently split an `MGET` into individual `GET` commands, this loses the atomicity and is not a universal solution for all multi-key commands. Hash tags (`user:{123}:profile`) explicitly ensure related keys are co-located, allowing atomic operations and scripts to execute without issue.

## Trade-offs and gotchas

Redis Cluster is a powerful tool, but it's not a silver bullet. Understanding its inherent trade-offs and potential pitfalls is crucial for operating it reliably at scale.

*   **Hash Tag Misuse: The Hot Slot Problem**
    While hash tags are excellent for co-locating related data, overuse or poor design can lead to **hot slots**. If you funnel too much unrelated data into a single hash tag (e.g., `application:{global_cache}:item`), that single slot can become a bottleneck, negating the benefits of sharding. Always distribute your hash tags across meaningful entities to ensure even load distribution.
*   **The Nuance of 16384 Slots**
    The 16384 slot design is efficient for gossip, but it means the minimum unit of data migration is a single slot. With 100 master nodes, each node manages ~164 slots. If a master fails, its replica must assume responsibility for all 164 slots, which can represent a significant memory and operational load on that single replica during failover.
*   **Quorum Requirements for Failover**
    Redis Cluster uses a majority-based voting system for master failure detection and replica promotion. This means you need a strict majority of *master* nodes to agree on a failure before a replica can promote itself. For a 3-master cluster, losing just one master means you've lost quorum (2/3 is not a strict majority), leading to cluster unavailability. A minimum of 3 masters (each with at least one replica) is required for basic availability, but 5 or 7 masters are often recommended for robust resilience against multiple master failures and network partitions.
*   **Asynchronous Replication: The Data Loss Footprint**
    Redis Cluster's replication is asynchronous. A master might acknowledge a write to a client and then fail *before* that write has been fully propagated to its replicas. In such a scenario, the promoted replica will not have that last write, leading to potential data loss. If strong consistency is paramount, you must use the `WAIT numreplicas timeout` command after writes to block until the write is confirmed by a specified number of replicas. Be aware that `WAIT` comes with latency implications.
*   **Client Complexity**
    Unlike standalone Redis, Redis Cluster demands **cluster-aware clients**. These clients must implement the logic to parse `MOVED` and `ASK` redirects, update their internal slot-to-node maps, and correctly handle `ASKING` during migration. Using a non-cluster-aware client will result in continuous `MOVED` errors, rendering your cluster unusable.
*   **Network Partitions and Split-Brain**
    While Redis Cluster is designed to be resilient, severe network partitions can lead to complex scenarios. If a network partition splits the cluster's master nodes into two segments, neither segment might be able to achieve quorum to elect new masters if existing masters fail within their partition. This can lead to a **split-brain** condition where parts of your cluster believe they are the authoritative source, leading to inconsistency once the partition heals.
*   **Resharding Performance Impact**
    Although resharding is an online operation, the `MIGRATE` command used to move keys is a blocking operation on the source and destination nodes for the duration of the key transfer. Moving many large keys concurrently can cause temporary latency spikes and increased CPU/network utilization on the involved nodes. Plan resharding during low-traffic periods and monitor your nodes closely.

| Feature             | Redis Cluster                                                                                                              | Standalone Redis + External Orchestration (e.g., Sentinel/K8s)                                                  |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| **Sharding**        | Automatic via 16384 hash slots. Cluster manages slot ownership.                                                            | Manual (client-side hashing). External system only handles failover, not data distribution.                     |
| **Failover**        | Automatic master election by replicas via gossip. Requires quorum of masters.                                              | External system (Sentinel, K8s operator) detects failures and promotes replicas.                                |
| **Redirection**     | Built-in `MOVED`/`ASK` redirects. Client updates its slot map.                                                             | Client must explicitly know which shard to query via config or service discovery.                               |
| **Multi-key Ops**   | Possible with **hash tags** (guaranteed co-location).                                                                      | Only if keys happen to land on the same shard by chance or careful client-side sharding design.                 |
| **Scaling**         | Horizontal scaling (adding/removing nodes, resharding slots) is built-in and online.                                       | Scaling requires adding new standalone instances and manual re-sharding logic updates in the client.            |
| **Operational Cplx**| Higher (cluster bus, node IDs, quorum, resharding tools, cluster-aware clients).                                           | Lower for Redis itself, but shifts complexity to external orchestration and client-side sharding logic.         |
| **Consistency**     | Asynchronous replication (potential data loss). `WAIT` can increase durability.                                            | Asynchronous by default. `WAIT` can also be used.                                                               |
| **Data Locality**   | Guaranteed for hash-tagged keys.                                                                                           | Depends entirely on client-side sharding algorithm.                                                             |
| **Discovery**       | Nodes self-discover and maintain cluster state via gossip.                                                                 | Client needs a separate discovery mechanism (e.g., Sentinel, external service discovery).                       |

## Production checklist

Before you put your Redis Cluster into the wild, run through this checklist. Your future self (the one responding to 3 AM PagerDuty alerts) will thank you.

*   **Cluster Sizing & Topology:**
    *   Deploy at least 3 master nodes, each with at least 1 replica. For higher resilience, consider 5-7 masters.
    *   Distribute master and replica nodes across different availability zones or physical hosts to tolerate infrastructure failures.
*   **`cluster-node-timeout`:**
    *   Set this configuration parameter judiciously (e.g., 5000ms). Too short increases false positives during network blips; too long delays failovers.
*   **Memory Footprint:**
    *   Account for replica buffering on masters and the memory overhead of `clusterNode` structs, especially in clusters with many nodes.
*   **Monitoring & Alerting:**
    *   **Redis Cluster Specific Metrics:** Track `redis_cluster_nodes_pfailed`, `redis_cluster_known_nodes`, `redis_cluster_state` (e.g., `ok`, `fail`).
    *   **Node-level Metrics:** Standard CPU, memory, network I/O, and Redis command/latency metrics for *all* master and replica nodes.
    *   **Logs:** Monitor Redis logs for `FAIL`, `MOVED`, `ASK`, `MIGRATING`/`IMPORTING` messages, and `CROSSSLOT` errors. Set up alerts for `FAIL` state.
*   **Client Library Proficiency:**
    *   Verify your chosen client library is fully cluster-aware and correctly handles `MOVED` and `ASK` redirects.
    *   Thoroughly test failover scenarios (simulated master failures) with your client.
*   **Key Naming & Hash Tag Strategy:**
    *   Establish clear key naming conventions.
    *   Use hash tags (`{...}`) deliberately to co-locate related data for multi-key operations, but avoid creating hot slots by funneling too much traffic into a single tag.
*   **Resharding Procedures:**
    *   Practice resharding in a staging environment.
    *   Always perform resharding during off-peak hours if possible.
    *   Monitor source and destination node performance (CPU, network) closely during migration.
    *   Use `redis-cli --cluster check <ip>:<port>` before and after resharding to validate cluster health.
*   **Data Consistency Requirements:**
    *   If your application cannot tolerate potential data loss on failover, implement the `WAIT` command after critical writes. Understand the latency implications.
*   **Network Configuration:**
    *   Ensure the cluster bus port (data port + 10000) is open between all cluster nodes.

## Interview questions

1.  **Question:** You notice your Redis Cluster client consistently receives `MOVED` redirects, even after updating its internal slot map. What could be a deeper issue, and how would you debug it?

    *   **Model Answer:** Consistent `MOVED` redirects suggest a fundamental problem with the cluster's health or stability, rather than just a stale client cache.
        *   **Possible issues:**
            1.  **Ongoing Resharding:** A resharding operation could be actively moving the slots your client is trying to access, leading to repeated `MOVED` messages as slots transition.
            2.  **Unstable Cluster:** Frequent master failures and replica promotions (perhaps due to resource starvation or network flapping) would cause the slot-to-node map to change rapidly, preventing the client from ever converging on a stable view.
            3.  **Split-Brain:** A network partition or misconfiguration might have led to different parts of the cluster having conflicting views of slot ownership.
            4.  **Client Bug:** Despite best intentions, the client's `MOVED` handling logic itself might be flawed, perhaps failing to update the map correctly or caching it inefficiently.
        *   **Debugging steps:**
            1.  **Check Cluster Health:** Use `redis-cli --cluster check <node_ip>:<port>` to get a global view of the cluster state. Look for `FAIL` nodes, inconsistent slot maps, or `no slots` messages.
            2.  **Inspect Node Logs:** Look for messages like `clusterNodeUpdateSlot` (slot map changes), `failover` events, or error messages related to gossip.
            3.  **Monitor Cluster Bus:** Observe traffic on the cluster bus port (e.g., 16379) for excessive or erratic PING/PONG messages, indicating instability.
            4.  **Verify Resharding Status:** Confirm if any resharding operations are in progress.
            5.  **Client-Side Logging:** Enhance client-side logging to show *when* a `MOVED` is received, *which slot* it refers to, and *how* the client updates its internal map. This helps pinpoint if the client is updating, but the cluster is changing faster.

2.  **Question:** You have a critical application that needs to perform atomic `MULTI`/`EXEC` operations on related user data, spread across multiple Redis keys (e.g., `user:profile:123`, `user:session:123`, `user:cart:123`). How would you design your key schema in Redis Cluster to ensure these operations succeed, and what would happen if you didn't?

    *   **Model Answer:** To ensure atomic `MULTI`/`EXEC` operations succeed, all keys involved must reside on the same Redis Cluster node. This is achieved by using **hash tags**.
        *   **Key Schema Design:** I would modify the key names to include a hash tag, ensuring the common identifier (the user ID `123` in this case) is enclosed in curly braces. For example:
            *   `user:{123}:profile`
            *   `user:{123}:session`
            *   `user:{123}:cart`
            When Redis Cluster calculates the hash slot for these keys, it will only consider the substring inside the first pair of `{}` (i.e., `123`). Since `CRC16("123") % 16384` will always yield the same slot number, all three keys are guaranteed to be co-located on the same master node.
        *   **Consequence Without Hash Tags:** If hash tags were not used, the full key names (`user:profile:123`, `user:session:123`, `user:cart:123`) would be hashed independently. Given Redis's `CRC16` distribution, it's highly probable that these distinct keys would map to *different* hash slots. Attempting a `MULTI`/`EXEC` block (or any other multi-key atomic command like `SUNION` or Lua scripts) on keys across different slots would result in a `CROSSSLOT` error, causing the operation to fail entirely.
