---
title: 'The Agent Loop: Tool Use, ReAct, and Memory from Scratch'
description: >-
  Learn how to build a production-ready AI agent from first principles: master
  function calling, ReAct loops, and memory design in Python, avoiding common…
pubDate: '2026-08-17'
tags:
  - ai-agents
  - llm-ops
  - python
  - backend
  - system-design
category: ai-engineering
draft: false
aiAssisted: true
readingTime: 16
linkedinHook: >-
  Your LLM chatbot just confidently told a customer their order was delivered,
  despite the tracking showing it's still in the warehouse. Why? Because it
  couldn't act.
linkedinBody: >-
  This post breaks down how to give your AI agency: integrating external tools,
  managing conversation memory, and building the iterative ReAct loop. We'll
  even build a small framework in Python. This is how you make LLMs go beyond
  chat and actually get work done.
---
## Introduction & Hook

Picture this: your new "AI-powered" customer service bot is live. A user asks, "What's the status of my order for the 'Quantum Leaper 3000'?" The bot, with a polite flourish, confidently replies, "Your order is confirmed and will arrive by tomorrow!" The only problem? It has absolutely no idea what "Quantum Leaper 3000" is, let alone an order ID or tracking information. It just made something up, because it lacks the ability to *do* anything besides generate plausible text.

This isn't a failure of the **Large Language Model (LLM)** itself. It's a failure of our system to give the LLM the tools and process it needs to operate in the real world. LLMs are incredible pattern matchers and text generators, but they are inherently stateless and isolated. They don't know your database, can't call your APIs, and forget everything after one turn. This is where **AI agents** come in.

An AI agent wraps an LLM with the ability to perceive, think, and act. It gives the LLM senses (via tool observations) and hands (via tool execution). This post will demystify how to build such an agent from scratch, focusing on three core pillars: **Tool Use**, the **ReAct loop** for reasoning, and effective **Memory** management. We'll show you how to turn a smart parrot into a proactive problem-solver.

## How it Works (The Visual Example)

Let's build on our customer service bot example. Instead of hallucinating, a proper AI agent would reason through the problem. Imagine the user asks, "Where is my order for the 'Quantum Leaper 3000'? My customer ID is user123."

Here's the internal monologue and action sequence of our agent:

1.  **User Input:** "Where is my order for the 'Quantum Leaper 3000'? My customer ID is user123."
2.  **LLM Receives Input & Memory:** The agent feeds this query, plus any prior conversation history (**Memory**), to the LLM. It also presents the LLM with a list of available **tools**—effectively, a user manual for its capabilities.
3.  **LLM's Thought:** "Okay, the user wants to know their order status. I first need to identify the product ID for 'Quantum Leaper 3000'. Then, with the customer ID, I can find their specific order, and finally track it."
4.  **LLM's Tool Call Generation:** Based on its thought, the LLM decides to use the `search_product_id` tool. Critically, the LLM *doesn't execute code*. Instead, it generates a structured text output—often JSON—that *describes* the tool call it wants to make. Something like `{'tool_calls': [{'id': 'call_123', 'function': {'name': 'search_product_id', 'arguments': '{"product_name": "Quantum Leaper 3000"}'}}]}`. This is the heart of **function calling internals**. Our agent framework parses this output.
5.  **Agent Executes Tool:** Our framework takes the LLM's requested tool call, validates the arguments, and executes the actual `search_product_id` Python function on our backend.
6.  **Observation:** The `search_product_id` tool returns "QL3K-42". This result is sent back to the agent framework.
7.  **Agent Feeds Observation to LLM:** The agent adds this `Observation` to its **Memory** (the conversation history) and calls the LLM again. This completes one cycle of the **ReAct loop**: **Thought, Action (Tool Call), Observation.**
8.  **LLM's Next Thought:** "I have the product ID ('QL3K-42') and the customer ID ('user123'). Now I need to find the specific order ID for this product from the customer's orders."
9.  **LLM's Tool Call Generation:** It generates a call to `get_customer_orders` with `{ "customer_id": "user123" }`.
10. **Agent Executes Tool:** The `get_customer_orders` tool is executed, returning `[{"order_id": "ORD-98765", "product_id": "QL3K-42", "status": "processing"}]`.
11. **Observation:** This result is fed back to the LLM's **Memory**.
12. **LLM's Next Thought:** "Great, I've found the relevant order ID: 'ORD-98765'. Now I need to track its status."
13. **LLM's Tool Call Generation:** It calls `track_order` with `{ "order_id": "ORD-98765" }`.
14. **Agent Executes Tool:** The `track_order` tool returns `{"status": "In transit", "estimated_delivery": "2024-12-25"}`.
15. **Observation:** This final observation goes back to the LLM.
16. **LLM's Final Answer:** "Your order for the Quantum Leaper 3000 (Order ID: ORD-98765) is currently in transit and expected to be delivered by December 25th, 2024." The LLM generates the final response, which the agent then returns to the user.

This iterative process of **Thought, Action, Observation** is the **ReAct loop**. It's how an agent tackles complex, multi-step problems by breaking them down, using tools, and learning from the outcomes.

## Real-world Use Cases

AI agents, empowered by tool use and iterative reasoning, transform LLMs from passive chatbots into active participants in your systems.

They are a lifesaver in scenarios like:

*   **Dynamic Customer Service**: "Reschedule my flight to next Tuesday and ensure I have a window seat." (Requires checking availability, initiating a change, confirming the seat, sending a new confirmation email – multiple API calls orchestrated.)
*   **Data Analysis & Reporting**: "Pull me a report on Q3 sales in Europe, broken down by country and product category, and highlight regions with over 10% growth." (Involves database queries, data aggregation, potentially calling an external BI tool or generating a spreadsheet.)
*   **DevOps Automation**: "Scale up the web tier for the 'Payments' service by 20% and check the new load balancer health." (Triggers Kubernetes commands, checks monitoring dashboards, reports status.)
*   **Research Assistants**: "Summarize the top three recent scientific papers on quantum computing advancements and identify the most cited authors." (Uses web search tools, PDF parsers, citation index lookups.)

However, agents are not a silver bullet. They become an anti-pattern when:

*   **The Problem is a Simple Q&A**: If the LLM can answer directly from its training data, adding agentic overhead is unnecessary.
*   **The Workflow is Strictly Deterministic**: For static A -> B -> C flows, traditional orchestration (e.g., a simple state machine or BPMN workflow) is more reliable, efficient, and easier to debug than introducing LLM-driven non-determinism.
*   **Latency is Critical**: Each tool call means an API roundtrip and an LLM inference step. Agents are inherently slower than direct LLM calls or deterministic code.
*   **Sensitive Operations Lack Guardrails**: An agent, left unchecked, might misinterpret a goal and execute a costly or destructive action if not properly constrained and monitored.

## Implementation & Code

Building a minimal agent framework involves defining tools, managing conversation memory, and implementing the ReAct loop. We'll use Python for its clarity and the ecosystem around LLMs.

A naive approach would be to feed the LLM a massive prompt describing all tools and asking it to solve everything in one go. This quickly breaks. The LLM gets confused, hallucinates tool names or arguments, or just ignores the tools entirely.

Our robust approach uses the iterative ReAct loop, feeding observations back to the LLM and keeping its context focused on the next logical step.

```python
import json
from typing import List, Dict, Callable, Any, Type, Optional
from pydantic import BaseModel, Field

# --- 1. Define the LLM Interaction (Mock for simplicity) ---
# In production, this would be an actual OpenAI, Anthropic, etc., client.
class MockLLMClient:
    def __init__(self, responses: List[str]):
        self.responses = iter(responses)
        self.history = [] # For debugging what the LLM received

    def chat_completion(self, messages: List[Dict[str, str]], tools: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        self.history.append(messages)
        try:
            response_content = next(self.responses)
            # Simulate an OpenAI-like tool_calls response or regular content response
            if response_content.startswith("{'tool_calls'"):
                # LLM wants to call a tool. Parse the mock JSON.
                return {"role": "assistant", "content": None, "tool_calls": json.loads(response_content.replace("'", '"'))["tool_calls"]}
            # LLM provides a direct text response (e.g., a final answer or intermediate thought).
            return {"role": "assistant", "content": response_content}
        except StopIteration:
            return {"role": "assistant", "content": "I'm out of programmed responses. Task incomplete."}

# --- 2. Define our Tools ---
# Tools are just Python functions wrapped with metadata (name, description, schema).

class Tool:
    def __init__(self, name: str, description: str, func: Callable, args_schema: Type[BaseModel]):
        self.name = name
        self.description = description
        self.func = func
        self.args_schema = args_schema # Pydantic model for argument validation and schema generation
    
    def to_llm_tool_format(self) -> Dict[str, Any]:
        # Converts our Tool definition into the format expected by LLM APIs for function calling.
        # This typically includes a JSON Schema for the function's arguments.
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.args_schema.model_json_schema() # Pydantic generates JSON Schema
            }
        }

# Define Pydantic schemas for each tool's arguments
class SearchProductIDArgs(BaseModel):
    product_name: str = Field(description="The full name of the product to search for.")

class GetCustomerOrdersArgs(BaseModel):
    customer_id: str = Field(description="The unique identifier for the customer.")

class TrackOrderArgs(BaseModel):
    order_id: str = Field(description="The unique identifier for the order to track.")

# Implement the actual tool functions (these would be API calls or DB queries in real life)
def search_product_id(product_name: str) -> str:
    print(f"  Tool Action: Searching product ID for '{product_name}'...")
    if "Quantum Leaper 3000" in product_name:
        return "QL3K-42"
    return "PRODUCT_NOT_FOUND"

def get_customer_orders(customer_id: str) -> List[Dict[str, str]]:
    print(f"  Tool Action: Fetching orders for customer '{customer_id}'...")
    if customer_id == "user123":
        return [
            {"order_id": "ORD-98765", "product_id": "QL3K-42", "status": "processing"},
            {"order_id": "ORD-11223", "product_id": "WidgetX", "status": "shipped"}
        ]
    return []

def track_order(order_id: str) -> Dict[str, str]:
    print(f"  Tool Action: Tracking order '{order_id}'...")
    if order_id == "ORD-98765":
        return {"status": "In transit", "estimated_delivery": "2024-12-25", "carrier": "FedEx"}
    return {"status": "Order Not Found"}


# --- 3. The Core AI Agent Framework ---
class AIAgent:
    # A crucial guardrail: prevents infinite loops and controls costs.
    MAX_ITERATIONS = 10 

    def __init__(self, llm_client: Any, tools: List[Tool], system_prompt: str):
        self.llm_client = llm_client
        # Map tool names to Tool objects for quick lookup during execution.
        self.tools = {tool.name: tool for tool in tools} 
        # Agent's memory: A list of messages that represents the conversation history.
        # The system prompt sets the agent's persona and instructions.
        self.memory: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}] 

    def _execute_tool(self, tool_name: str, args: Dict[str, Any]) -> str:
        """Executes a named tool with provided arguments."""
        tool_obj = self.tools.get(tool_name)
        if not tool_obj:
            return f"Error: Tool '{tool_name}' not found or not registered."
        
        try:
            # For robust production systems, validate args against `tool_obj.args_schema` here.
            # Example: validated_args = tool_obj.args_schema(**args).dict()
            result = tool_obj.func(**args) # Execute the actual Python function
            return json.dumps(result) # Return tool output as a JSON string for the LLM
        except Exception as e:
            # Critical for debugging: capture and return tool errors to the LLM.
            return f"Error executing tool '{tool_name}' with args {args}: {e}"

    def run(self, user_query: str) -> str:
        """Runs the ReAct loop for a given user query."""
        # 1. Add the user's initial query to the agent's memory.
        self.memory.append({"role": "user", "content": user_query})

        for i in range(self.MAX_ITERATIONS):
            print(f"\n--- Agent Iteration {i+1} ---")
            
            # 2. Call the LLM with the current conversation history (memory) and available tools.
            # The LLM decides whether to respond directly or call a tool.
            response_message = self.llm_client.chat_completion(
                messages=self.memory, 
                tools=[tool.to_llm_tool_format() for tool in self.tools.values()] # Provide tool schemas
            )
            
            # 3. Process the LLM's response.
            # OpenAI-style function calling gives us `tool_calls` or `content`.
            if response_message.get("tool_calls"):
                # The LLM decided to call one or more tools.
                tool_calls = response_message["tool_calls"]
                
                # Add the LLM's tool call decision to memory.
                # This is important: the LLM explicitly stated it's calling a tool.
                self.memory.append({"role": "assistant", "tool_calls": tool_calls})
                print(f"Agent Thought: LLM decided to call tool(s).")

                # Execute each tool call and add its observation back to memory.
                for tool_call in tool_calls:
                    tool_name = tool_call["function"]["name"]
                    # LLMs provide arguments as a JSON string; we parse it.
                    tool_args = json.loads(tool_call["function"]["arguments"]) 
                    
                    print(f"  Action: Calling '{tool_name}' with args: {tool_args}")
                    tool_output = self._execute_tool(tool_name, tool_args)
                    print(f"  Observation: '{tool_name}' returned: {tool_output[:100]}...") # Truncate for display

                    # The crucial step of the ReAct loop: feed the tool's output back as an observation.
                    self.memory.append({
                        "role": "tool",
                        "tool_call_id": tool_call["id"], # Relates observation back to the specific call
                        "name": tool_name,
                        "content": tool_output
                    })
            elif response_message.get("content"):
                # The LLM provided a direct text response. This is likely the final answer.
                final_answer = response_message["content"]
                self.memory.append({"role": "assistant", "content": final_answer}) # Store final answer
                print(f"Agent Final Answer: {final_answer}")
                return final_answer
            else:
                # Unexpected response from LLM, or it couldn't decide.
                print("Agent Error: LLM returned an empty or unexpected response.")
                break

        # If the agent exhausts max iterations without a final answer.
        print("\nAgent failed to complete the task within max iterations.")
        return "I could not complete your request. Please try again or provide more details."

# --- Agent Setup and Execution ---
system_prompt = """You are a helpful and precise customer service AI agent. Your primary goal is to assist users with their order inquiries by using your tools to gather accurate information. Always strive to provide a definitive answer using the available tools. If a piece of information is missing (like a customer ID), ask the user for it."""

available_tools = [
    Tool(name="search_product_id", description="Searches for a product ID given its name.", func=search_product_id, args_schema=SearchProductIDArgs),
    Tool(name="get_customer_orders", description="Retrieves a list of orders for a given customer ID.", func=get_customer_orders, args_schema=GetCustomerOrdersArgs),
    Tool(name="track_order", description="Tracks the status and estimated delivery of an order using its ID.", func=track_order, args_schema=TrackOrderArgs)
]

# Simulate a sequence of LLM responses that drive the ReAct loop forward
mock_llm_responses_sequence = [
    # Iteration 1: User query -> LLM decides to search product ID
    "{'tool_calls': [{'id': 'call_abc123', 'type': 'function', 'function': {'name': 'search_product_id', 'arguments': '{\"product_name\": \"Quantum Leaper 3000\"}'}}]}",
    # Iteration 2: After product ID found -> LLM decides to get customer orders
    "{'tool_calls': [{'id': 'call_def456', 'type': 'function', 'function': {'name': 'get_customer_orders', 'arguments': '{\"customer_id\": \"user123\"}'}}]}",
    # Iteration 3: After customer orders found -> LLM decides to track the specific order
    "{'tool_calls': [{'id': 'call_ghi789', 'type': 'function', 'function': {'name': 'track_order', 'arguments': '{\"order_id\": \"ORD-98765\"}'}}]}",
    # Iteration 4: After tracking info found -> LLM forms the final answer
    "Your order for the Quantum Leaper 3000 (Order ID: ORD-98765) is currently in transit and expected to be delivered by December 25th, 2024 via FedEx."
]

mock_llm_client = MockLLMClient(responses=mock_llm_responses_sequence)
agent = AIAgent(llm_client=mock_llm_client, tools=available_tools, system_prompt=system_prompt)

final_response = agent.run("Where is my order for the 'Quantum Leaper 3000'? My customer ID is user123.")
print(f"\n--- Final Agent Response ---\n{final_response}")
```

**Memory Design**: In our minimal agent, `self.memory` is simply a list of message dictionaries. Each message contains a `role` (`system`, `user`, `assistant`, `tool`) and `content`. Tool calls and their observations are also appended. This is the simplest form of **short-term memory**, keeping the LLM aware of the current conversation thread. It's sufficient for basic tasks but quickly hits the LLM's context window limits for longer, more complex interactions.

**Guardrails**: The `MAX_ITERATIONS` constant is a critical **guardrail**. Without it, an agent could get stuck in an infinite loop of calling tools or asking clarifying questions, burning through tokens and compute. Other essential guardrails include argument validation before tool execution and strict timeouts.

## Senior-Level Insights & Gotchas

Building production-grade AI agents means looking beyond the basics. Here's what often trips up even senior engineers:

### ReAct vs. Plan-and-Execute

The **ReAct loop** (Thought, Action, Observation) is what we implemented. It's simple, highly reactive, and great for dynamic, less structured tasks. However, it can sometimes get lost in complex, multi-step scenarios, leading to redundant steps or incorrect tool choices.

For high-stakes, multi-stage tasks, consider **Plan-and-Execute**. Here, the agent first generates a multi-step *plan* using one LLM call (the "planner"), then executes that plan step-by-step, using another LLM (the "executor") to decide the *exact* tool call for each step, sometimes re-planning if execution fails. This adds robustness but also complexity and latency. ReAct is your default; Plan-and-Execute is for when deterministic reliability outweighs reactivity.

### Beyond Simple Memory

Our list-based memory is a starting point. For anything serious, you'll hit **context window limits** fast. Deep architectural memory solutions involve:

*   **Summarization**: An LLM periodically summarizes older conversation segments, reducing their token count while retaining key information.
*   **Vector Databases (Long-term Memory)**: Embeddings of past interactions, user preferences, or retrieved knowledge bases allow the agent to semantically search and retrieve only relevant context, augmenting the current conversation. This creates a powerful **Retrieval Augmented Generation (RAG)** pipeline *within* the agent.
*   **Hierarchical Memory**: Combine short-term (current conversation), medium-term (summarized past conversations, recent user preferences), and long-term (personal knowledge base, user profile, past tasks).

The goal isn't to store *everything*, but to store and retrieve *the right things* at the right time.

### Robust Function Calling Internals

Remember, the LLM *generates text describing a function call*. It doesn't actually call the function. This means:

1.  **Strict Argument Validation**: Always validate the LLM's generated arguments against your tool's schema *before* execution. Pydantic (as used in our example for schema generation) is excellent for this. Don't trust the LLM implicitly; it *will* occasionally generate invalid JSON or incorrect argument types.
2.  **Error Handling**: If a tool call fails, capture the error, format it cleanly, and feed it back to the LLM as an `Observation`. A well-designed agent can learn from its mistakes and attempt recovery (e.g., trying a different tool or re-asking the user).
3.  **Tool Description Quality**: The LLM is only as good as the tool descriptions you give it. Vague or ambiguous descriptions lead to incorrect tool usage. Be precise about what each tool does, its inputs, and its outputs.

### Comprehensive Guardrails

Beyond iteration limits, critical guardrails include:

*   **Rate Limiting on Tools**: Prevent an agent from spamming your downstream APIs.
*   **Cost Monitoring**: Track token usage and tool call frequency. Agents can become very expensive very quickly. Implement circuit breakers.
*   **Human-in-the-Loop**: For high-impact or sensitive operations (e.g., placing an order, deleting data), require explicit human confirmation. The agent proposes the action, and a human reviews and approves.
*   **Fallback Strategies**: If an agent fails to complete a task after `MAX_ITERATIONS`, don't just hang. Provide a graceful fallback, like handing off to a human agent or suggesting a simpler query.

### Observability is Non-Negotiable

Debugging an agent's reasoning is incredibly hard without proper logs. Instrument every `Thought`, `Tool Call`, `Tool Output`, and `Observation`. Use unique trace IDs for each agent session. This granular logging is essential for understanding why an agent chose a particular path, where it failed, and how to improve its prompts or tool definitions.

## Summary & Production Checklist

Building an AI agent is about giving your LLM agency: the ability to perceive, think, and act in your system. Master these concepts, and you'll move beyond chat and into true automation.

Here's your production checklist for building robust AI agents:

*   **Tool Definition**:
    *   Define clear, atomic tools with precise descriptions and Pydantic schemas.
    *   Ensure tool functions are idempotent where possible.
*   **ReAct Loop**:
    *   Implement an iterative loop: LLM generates Thought/Tool Call -> Agent executes Tool -> Tool Output (Observation) fed back to LLM.
    *   Limit iterations (`MAX_ITERATIONS`) to prevent infinite loops and control costs.
*   **Memory Management**:
    *   Start with simple conversation history (list of messages).
    *   Plan for long-term memory solutions (summarization, vector databases) to overcome context window limits.
    *   Ensure all relevant context (user ID, session ID) is included in each LLM call.
*   **Function Calling**:
    *   **Always** parse and validate LLM-generated tool call arguments against your schemas *before* execution.
    *   Handle tool execution errors gracefully, feeding clear error messages back to the LLM.
*   **Guardrails & Safety**:
    *   Implement strict input/output validation on all tools.
    *   Add rate limiting, timeouts, and cost monitoring.
    *   Design for human-in-the-loop for high-impact actions.
    *   Plan for graceful fallbacks when agents fail or get stuck.
*   **Observability**:
    *   Log every step of the agent's reasoning (Thoughts, Actions, Observations) with clear trace IDs.
    *   Monitor token usage and latency per interaction.
