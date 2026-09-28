---
title: Scaling Real-Time Chat to 10M Concurrent Users
description: >-
  Learn to design a real-time chat system for millions of users. Master
  WebSocket scaling, pub/sub architecture, message ordering, and presence
  detection.
pubDate: '2026-09-28'
tags:
  - system-design
  - real-time
  - chat
  - websockets
  - kafka
category: system-design
draft: false
aiAssisted: true
readingTime: 17
linkedinHook: >-
  Most engineers underestimate the nightmare of scaling a chat system to 10
  million concurrent users. Here's how to build one that doesn't melt down.
linkedinBody: >-
  I just wrote about the architectural patterns behind battle-tested chat
  systems. If you've ever wondered how WhatsApp or Slack keep millions talking,
  this dives into the core tech like WebSockets and message brokers.
---
## Introduction & Hook

Picture this: your company just launched a major new product. You're expecting a surge, but then the CEO starts a live AMA in your shiny new in-app chat. Within minutes, instead of celebratory emojis, you see messages like "Connection lost," "Message failed to send," and the dreaded spinner of doom. The metrics dashboard is a sea of red, and that brand-new chat service designed to foster community just imploded, taking trust with it. All because 10 million *concurrent* users isn't just "more users" – it's an entirely different universe of engineering challenges.

Building a chat feature for a small team is trivial. Drop in a library, spin up a server, done. But scale that to a global audience, where millions are actively sending and receiving messages *at the exact same time*, and the rules change. It's no longer about simple request-response. We need to maintain state, distribute messages globally, ensure every message arrives quickly and in order, and know who's online *right now*. This post breaks down how to design a real-time chat system that can handle 10 million active users without breaking a sweat, ensuring your next big launch is a success, not a meltdown.

## How it Works (The Visual Example)

Forget traditional HTTP. For real-time chat, we need **WebSockets**. Think of WebSockets not as a quick chat, but as a dedicated, open telephone line between each user's device and your backend server. Once established, this line stays open, allowing both sides to send messages whenever they want, without the overhead of constantly initiating new connections. This bi-directional, persistent connection is the bedrock of real-time communication.

Now, imagine you have 10 million people on these open phone lines. You can't put all those phone lines into one building. That building would collapse. You need thousands of distributed call centers, each managing a fraction of the total connections.

Here's the visual mental model:
1.  **The Call Centers (Chat Servers):** You have hundreds, maybe thousands, of backend servers. Each one handles a subset of the 10 million open WebSocket connections. When a user (let's call her Alice) connects, her phone line (WebSocket) goes directly to one of these `Chat Servers`.
2.  **The Central Broadcast Station (Message Broker):** If Alice wants to send a message to her friend Bob, or to a group, her `Chat Server` doesn't know where Bob is connected. He might be on a different `Chat Server` instance. So, Alice's `Chat Server` sends her message to a central, high-throughput **message broker** (like Kafka or Redis Pub/Sub). This broker is like a massive radio station that *all* your `Chat Servers` listen to.
3.  **The Receivers:** All `Chat Servers` are constantly tuned into the central message broker. When the broker broadcasts Alice's message, any `Chat Server` that has an active WebSocket connection for Bob (or any member of Alice's group) picks up the message and instantly forwards it down Bob's dedicated phone line.

Let's walk through Alice sending "Hello Bob!" to Bob and "Meeting at 3" to her 'Team' group:

1.  **Alice connects:** Alice's client establishes a WebSocket connection to `Chat Server A`. `Chat Server A` notes that Alice is online and stores this connection.
2.  **Alice sends message:** Alice types "Hello Bob!". Her client sends this message over her WebSocket to `Chat Server A`.
3.  **Persistence & Publish:** `Chat Server A` receives the message. It first **persists** "Hello Bob!" to a durable database (essential for message history and offline delivery). Then, it publishes the message to the central message broker, specifying Bob as the recipient.
4.  **Fan-out:** The message broker receives "Hello Bob!". Other `Chat Servers` (say, `Chat Server B`) are subscribed to messages for Bob. `Chat Server B` receives "Hello Bob!" from the broker.
5.  **Delivery:** Since `Chat Server B` holds Bob's active WebSocket connection, it immediately pushes "Hello Bob!" directly to Bob's client.
6.  **Group Message:** Simultaneously, Alice's `Chat Server A` also publishes "Meeting at 3" to the message broker, tagging it for the 'Team' group. All `Chat Servers` that have active WebSocket connections for any 'Team' members pick up this message from the broker and push it to their respective connected team members.

This **pub/sub fan-out** strategy is critical. It ensures `Chat Servers` remain **stateless** regarding who's connected where, allowing you to scale them horizontally by simply adding more instances. You avoid **sticky sessions**, where a load balancer tries to keep a user on the same server, which becomes a nightmare for scaling, fault tolerance, and maintenance.

## Real-world Use Cases

This architecture isn't just for theoretical discussions; it's the engine behind some of the most widely used applications on the planet:

*   **Social Media Messaging:** Think WhatsApp, Telegram, or Facebook Messenger. Billions of messages exchanged daily, instantly.
*   **Collaborative Tools:** Slack, Discord, Microsoft Teams. The real-time updates for messages, presence, and document edits rely heavily on this model.
*   **Live Events & Streaming Chat:** Twitch, YouTube Live, or even in-game chats. Hundreds of thousands of simultaneous messages during peak events.
*   **Real-Time Gaming:** In-game chat, leaderboards, and even some game state synchronization often leverage persistent connections and message broadcasting.

However, it's not a silver bullet. This approach becomes an **anti-pattern** when:

*   **Infrequent, Low-Volume Communication:** If your "chat" is just occasional notifications or infrequent status updates, the overhead of maintaining persistent WebSocket connections, a message broker, and a sophisticated presence system is overkill. A simple poll or server-sent events (SSE) might be more appropriate.
*   **Pure Request-Response:** For services that primarily involve a client making a request and waiting for a response (like fetching a static profile, submitting a form, or performing a database query), standard RESTful APIs are simpler, more efficient, and easier to scale horizontally without the complexity of WebSockets.
*   **Unidirectional Data Flow:** If data only ever flows from the server to the client (e.g., stock tickers, news feeds where users don't interact back), Server-Sent Events (SSE) offer a simpler alternative to WebSockets, without the full bi-directional complexity.

## Implementation & Code

A naive chat implementation might involve a single server handling all WebSocket connections, or a load balancer attempting **sticky sessions** based on IP. This immediately breaks at scale: the single server becomes a massive bottleneck, and sticky sessions introduce immense complexity for horizontal scaling (what if a server goes down? How do you rebalance? How do you ensure all messages for a user go to the *same* server, even across reconnections?).

A robust, production-ready system for 10 million users demands a distributed, stateless approach. Let's look at a simplified Go example for a single `ChatServer` instance that is designed to be part of a much larger, distributed system. It uses a mock Pub/Sub interface, but in production, this would be Kafka or Redis Pub/Sub.

```go
package main

import (
	"log"
	"net/http"
	"sync"
	"time" // Imported for potential future use or omitted in simplified version

	"github.com/gorilla/websocket"
)

// PubSub interface defines how our chat service interacts with the message broker.
// This abstraction allows us to swap out MockPubSub for Kafka or Redis Pub/Sub easily.
type PubSub interface {
	Publish(topic string, message []byte) error
	Subscribe(topic string) (chan []byte, error)
	Close()
}

// MockPubSub is a simplified in-memory PubSub for demonstration purposes.
// In a real system, this would be a client for Kafka, Redis Streams, or NATS.
type MockPubSub struct {
	subscribers map[string][]chan []byte // topic -> list of subscriber channels
	mu          sync.RWMutex             // Protects access to subscribers map
}

func NewMockPubSub() *MockPubSub {
	return &MockPubSub{
		subscribers: make(map[string][]chan []byte),
	}
}

// Publish sends a message to all subscribers of a given topic.
func (m *MockPubSub) Publish(topic string, message []byte) error {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if subs, ok := m.subscribers[topic]; ok {
		for _, sub := range subs {
			// Non-blocking send; if a subscriber's channel is full, we log a warning.
			// A real system might have more sophisticated backpressure or error handling.
			select {
			case sub <- message:
			default:
				log.Printf("Warning: Dropping message for topic %s, subscriber channel full.", topic)
			}
		}
	}
	return nil
}

// Subscribe registers a new subscriber for a topic and returns a channel to receive messages.
func (m *MockPubSub) Subscribe(topic string) (chan []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ch := make(chan []byte, 100) // Buffered channel to prevent blocking on publish
	m.subscribers[topic] = append(m.subscribers[topic], ch)
	return ch, nil
}

// Close cleans up all subscriber channels.
func (m *MockPubSub) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, subs := range m.subscribers {
		for _, ch := range subs {
			close(ch)
		}
	}
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// IMPORTANT: In production, strictly enforce your allowed origins
		return true 
	},
}

// ChatServer represents a single instance of our chat service.
// Multiple instances of ChatServer would run across your cluster.
type ChatServer struct {
	pubSub        PubSub                     // Interface to the message broker
	activeClients map[string]*websocket.Conn // userID -> active WebSocket connection on *this server*
	mu            sync.RWMutex               // Protects access to activeClients map
}

func NewChatServer(ps PubSub) *ChatServer {
	return &ChatServer{
		pubSub:        ps,
		activeClients: make(map[string]*websocket.Conn),
	}
}

// handleConnections upgrades HTTP requests to WebSocket, manages client lifecycle.
func (cs *ChatServer) handleConnections(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
	defer conn.Close() // Ensure connection is closed when handler exits

	// Get userID from request (e.g., from query param, JWT, or session cookie).
	// This is how we identify the user across the distributed system.
	userID := r.URL.Query().Get("userID") 
	if userID == "" {
		log.Println("Client connected without userID, closing connection.")
		return
	}

	cs.mu.Lock()
	cs.activeClients[userID] = conn // Store the connection for this specific server instance
	cs.mu.Unlock()

	log.Printf("User %s connected to THIS server.", userID)
	
	// Crucial: Clean up `activeClients` when the user disconnects or connection breaks.
	defer func() {
		cs.mu.Lock()
		delete(cs.activeClients, userID)
		cs.mu.Unlock()
		log.Printf("User %s disconnected from THIS server.", userID)
	}()

	// Each user should subscribe to their own private topic (for DMs)
	// and any group topics they are part of.
	// This ensures messages published for them find their way to this server.
	userMessageChan, err := cs.pubSub.Subscribe("user." + userID)
	if err != nil {
		log.Printf("Error subscribing %s to user topic: %v", userID, err)
		return
	}
	// Start a goroutine to continuously read messages for this user from the PubSub.
	go cs.readMessagesFromPubSub(conn, userMessageChan)

	// Main loop to read messages sent *from* this WebSocket client.
	for {
		messageType, p, err := conn.ReadMessage()
		if err != nil {
			log.Println("Read error from client (likely disconnect):", err)
			break // Exit loop and trigger defer cleanup
		}
		
		// In a real system, 'p' would be a structured JSON message (sender, receiver, content, etc.)
		log.Printf("Received message from %s: %s", userID, p)
		
		// Publish the incoming message to a global topic.
		// A message parser would determine the actual recipient topic(s) (e.g., "user.bob", "group.team-alpha").
		// Other ChatServer instances (and potentially this one) will pick it up via PubSub.
		err = cs.pubSub.Publish("global.chat", p) // Simplified: publish to a general topic
		if err != nil {
			log.Println("Error publishing message to PubSub:", err)
		}
	}
}

// readMessagesFromPubSub listens for messages from the PubSub system (e.g., Kafka)
// and writes them to the connected WebSocket client.
func (cs *ChatServer) readMessagesFromPubSub(conn *websocket.Conn, messageChan chan []byte) {
	for message := range messageChan {
		if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
			log.Println("Write error to client (from PubSub):", err)
			// Handle client disconnection or error gracefully; break loop to let goroutine exit
			return
		}
	}
}

func main() {
	// Initialize our mock PubSub. In production, this would be a Kafka/Redis client.
	mockPubSub := NewMockPubSub()
	defer mockPubSub.Close()

	// Instantiate a ChatServer.
	chatServer := NewChatServer(mockPubSub)

	// This *single* ChatServer instance also needs to subscribe to messages that it might
	// need to fan out to its connected clients. This simulates the distributed nature.
	// For instance, if another ChatServer publishes to "global.chat", *this* server
	// needs to receive it to push to its local clients.
	globalChatChan, err := mockPubSub.Subscribe("global.chat")
	if err != nil {
		log.Fatalf("Failed to subscribe to global chat: %v", err)
	}

	go func() {
		for msg := range globalChatChan {
			log.Printf("ChatServer received global.chat message from PubSub: %s", msg)
			// Iterate over all clients *currently connected to this specific server*
			// and push the message to them.
			// In a real system, the `msg` would contain recipient IDs, and we'd filter.
			cs.mu.RLock()
			for userID, clientConn := range chatServer.activeClients {
				log.Printf("Fanning out global.chat message to %s", userID)
				if err := clientConn.WriteMessage(websocket.TextMessage, msg); err != nil {
					log.Printf("Error fanning out to %s: %v", userID, err)
					// Handle write error (e.g., client disconnected unexpectedly)
				}
			}
			cs.mu.RUnlock()
		}
	}()

	http.HandleFunc("/ws", chatServer.handleConnections)
	log.Println("Chat server started on :8080. Connect with WebSocket client, e.g., ws://localhost:8080/ws?userID=alice")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// To run this:
// 1. Save as `main.go`
// 2. `go mod init chatserver`
// 3. `go get github.com/gorilla/websocket`
// 4. `go run main.go`
// 5. Connect with a WebSocket client (e.g., browser's DevTools console, Postman):
//    - `new WebSocket('ws://localhost:8080/ws?userID=user1')`
//    - Open multiple tabs/clients with different user IDs (e.g., `user2`, `user3`)
//    - Send a message from one client, and you'll see it fanned out to all connected clients.
```

The key takeaways from this code:

*   **Stateless `ChatServer`:** Each `ChatServer` instance only holds the WebSocket connections *it* initiated. It doesn't know about connections on other servers. This allows seamless horizontal scaling.
*   **Pub/Sub Decoupling:** The `PubSub` interface is crucial. When a message comes in from a client, it's *published* to the broker. When a message needs to go *out* to a client, it's *subscribed* from the broker. This separates the concerns of connection management from message routing.
*   **UserID is King:** Every connection needs a `userID`. This ID is used to subscribe to specific topics for direct messages and to map messages to the correct active client connection.

## Senior-Level Insights & Gotchas

Now for the deep cuts. What will keep you up at 3 AM when your system is melting?

### Message Ordering

This is trickier than it sounds. Messages published to a broker (especially Kafka) are generally ordered *per partition*. But what if a client connects to `Chat Server A`, sends a message, then quickly reconnects to `Chat Server B` and sends another? Or if network latency causes messages to arrive out of sequence?

*   **The Problem:** Messages from the same sender to the same recipient can arrive out of order. "Hey, you free?" then "Let's meet at 3" might appear as "Let's meet at 3" then "Hey, you free?".
*   **The Fix:** Assign a **monotonically increasing sequence number** at the *sender's client or service* for each chat. The client or the receiving service should then use this sequence number to re-order messages before display. For robustness, store this sequence number with the message in the database. Use a `(chat_id, sender_id, sequence_number)` composite primary key to detect and ignore duplicate messages delivered by the message broker (idempotent writes).

### Offline Delivery

What happens when Bob is offline, but Alice keeps sending him messages? When Bob finally comes back online, he needs to see everything he missed.

*   **The Problem:** Messages are pushed in real-time. If the receiver isn't connected, they won't get it.
*   **The Fix:** Every message, upon receipt by any `Chat Server`, *must* be persisted to a durable database (e.g., PostgreSQL with partitioning, or Cassandra/ScyllaDB for extreme scale). When Bob reconnects, his client makes an API call to a dedicated "history service" requesting all messages from his last seen message ID or timestamp for his chats. The history service queries the database and delivers these missed messages. Only *after* catching up is Bob's client ready for real-time messages.

### Presence Service

How do you know if Bob is "online," "away," or "last seen at 2:30 PM"? This is critical for UX.

*   **The Problem:** `Chat Servers` are stateless; they only know about their *own* active connections. No single server knows the global online status of all users.
*   **The Fix:** Implement a dedicated **Presence Service**, typically backed by Redis for its speed.
    *   When a user connects to *any* `Chat Server`, that server updates Redis: `SET user:{userID}:status "online" EX 60` (with a TTL).
    *   Clients send periodic **heartbeat** pings over their WebSocket connection. If a `Chat Server` receives a heartbeat, it updates the TTL for that user in Redis.
    *   If a `Chat Server` detects a WebSocket disconnection, it explicitly sets `user:{userID}:status "offline"`. If a user silently disappears (e.g., network cut), the Redis TTL will eventually expire, and a background process can mark them offline.
    *   **Redis Sorted Sets** can track `user:{userID}:last_seen_timestamp` for "last seen" functionality.

### WebSocket Scaling Beyond Nginx/HAProxy

You need more than just a `ChatServer` instance.

*   **Load Balancers:** Use a Layer 4 (TCP) load balancer (like AWS ELB, Google Cloud Load Balancer, or Nginx acting as a TCP proxy). Avoid Layer 7 HTTP load balancers if they terminate WebSockets and don't provide a way to pass the raw TCP connection, or if their WebSocket proxying adds too much overhead.
*   **Sticky Sessions:** Actively *avoid* sticky sessions. They complicate scaling and disaster recovery. With a robust Pub/Sub architecture, any `Chat Server` can handle any user's connection or message.
*   **Resource Management:** 10M concurrent WebSockets mean 10M open file descriptors across your fleet. Ensure your OS (Linux `ulimit`) is configured for high numbers of open files. Also, watch out for memory consumption: each connection consumes some memory for buffers, so plan your server instance sizes accordingly.
*   **Connection Draining:** When deploying new `Chat Server` versions, ensure your load balancer gracefully removes old instances. It should stop sending new connections to the old instances but keep existing ones open until they naturally close or drain. This prevents abrupt disconnections for active users.

### Backpressure

What if a user's client is on a terrible network and can't receive messages as fast as your system sends them? Or what if your message broker gets overloaded?

*   **The Problem:** Unchecked message flow can lead to client-side buffer overflows, server-side memory exhaustion, or message broker congestion, causing latency or crashes.
*   **The Fix:**
    *   **Client-side:** Implement client-side buffering and flow control. If the client can't process messages fast enough, it should signal backpressure to the server (e.g., by not acknowledging receipt, or a custom protocol message).
    *   **Server-side:** Use bounded queues for messages intended for clients. If a client's queue fills up, you might have to drop older messages, or temporarily disconnect the client (and let offline delivery handle the catch-up).
    *   **Message Broker:** Brokers like Kafka inherently handle backpressure through consumer offsets. Ensure your consumers (the `Chat Servers`) are configured with appropriate buffer sizes and processing rates.

## Summary & Production Checklist

Building a chat system for 10 million concurrent users isn't just about throwing more servers at the problem. It's about a fundamental shift in architecture. Here's your no-nonsense checklist:

*   **Stateless Chat Servers:** Design your `Chat Servers` to be truly stateless. They only manage active WebSocket connections, delegating message routing and persistence elsewhere.
*   **Robust Pub/Sub:** Implement a highly scalable message broker (Kafka, Redis Pub/Sub, NATS) for efficient message fan-out across all `Chat Servers`.
*   **Durable Message Persistence:** Persist *all* messages to a database (e.g., PostgreSQL, Cassandra, ScyllaDB) for history and crucial offline delivery.
*   **Dedicated Presence Service:** Use a fast key-value store (like Redis) to track user online/offline status with heartbeats and TTLs.
*   **Message Ordering:** Assign monotonically increasing sequence numbers to messages at the source to ensure correct order, even across network quirks. Implement idempotent writes.
*   **WebSocket Load Balancing:** Use Layer 4 TCP load balancers. Absolutely avoid sticky sessions with a well-designed Pub/Sub architecture.
*   **Resource Planning:** Configure OS limits (file descriptors), monitor network I/O, CPU, and memory consumption carefully on your `Chat Servers`.
*   **Graceful Shutdowns:** Ensure `Chat Servers` can gracefully drain existing connections during deployments to avoid user disruption.
*   **Backpressure Handling:** Implement flow control and bounded queues to prevent system overloads when clients or components can't keep up.
*   **Monitoring & Alerting:** Comprehensive monitoring of connection counts, message throughput, latency, and error rates is non-negotiable. Set up aggressive alerts for anomalies.

Master these principles, and you'll build chat systems that not only scale but thrive under the kind of load that makes lesser systems crumble. Go build something great!
