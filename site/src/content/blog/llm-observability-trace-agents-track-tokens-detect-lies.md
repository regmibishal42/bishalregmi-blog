---
title: 'LLM Observability: Trace Agents, Track Tokens, Detect Lies'
description: >-
  Master LLM observability to debug complex AI agents, optimize token costs, and
  spot hallucinations with OpenTelemetry and NLI models. A 10x guide.
pubDate: '2026-08-24'
tags:
  - llm-observability
  - opentelemetry
  - ai-agents
  - tracing
  - cost-attribution
  - hallucination-detection
  - nli
category: ai-engineering
draft: false
aiAssisted: true
readingTime: 14
linkedinHook: >-
  Your LLM application just spun up an expensive, nonsensical answer. Do you
  know why? Most devs don't. That's a production nightmare waiting to happen.
linkedinBody: >-
  I just dropped a post on LLM observability, covering how to trace multi-step
  agent chains, attribute costs, and even detect hallucinations. If you're
  building with LLMs, this will help you debug faster and ship more reliable
  systems.
---
## Introduction & hook

The clock hits 2 AM. Your on-call pager screams. Your new, shiny LLM-powered support agent, the one that was supposed to revolutionize customer service, just told a user their credit card information was completely invalid after they correctly entered it. An angry customer, a panicked engineering manager, and you staring at a blank log file wondering: *what just happened?* Was it the prompt? The RAG retrieval? A bad tool call? Did it just... make something up?

That's the nightmare scenario for every backend engineer building with Large Language Models today. Without proper visibility, your cutting-edge AI systems are black boxes. You're flying blind. This is exactly why **LLM Observability** isn't just a nice-to-have; it's non-negotiable for reliable, cost-effective, and safe production deployments. It’s the practice of instrumenting your LLM applications to understand their internal state, performance, and behavior. We're talking about tracing multi-step agent actions, tracking token usage for cost attribution, and actively detecting when your model starts to **hallucinate**.

This post isn't about vague monitoring; it’s a deep dive into how you gain true X-ray vision into your LLM pipelines, transforming them from unpredictable black boxes into transparent, debuggable systems.

## How it works (the visual example)

Let's trace a typical interaction with a multi-step LLM agent. Imagine a customer asks your e-commerce AI: "What's the status of my order for the 'Quantum Flux Capacitor'?"

Here's how that request, instrumented for observability, flows:

1.  **Initial Request (Parent Span):** The user's query hits your API gateway. An **OpenTelemetry trace** begins here. This is the root of your entire operation, like the starting point on a treasure map.
2.  **Agent Orchestration (Child Span 1):** Your main LLM agent receives the query. This is a child span of the initial request. Inside this span, you capture the incoming prompt, the agent's decision-making process, and its intent to call a tool.
3.  **Tool Call: Search Inventory (Child Span 2.1):** The agent decides it needs to find the "Quantum Flux Capacitor" product ID. It calls your internal product database service. This tool call becomes *another* child span. Here, you record the tool name, its input parameters (e.g., `product_name="Quantum Flux Capacitor"`), and the *duration* of the database lookup.
4.  **Tool Call: Order Lookup (Child Span 2.2):** Once the product ID is found, the agent realizes it needs to fetch order details. It calls your order management system API. Again, a new child span. Input: `user_id`, `product_id`. Output: `order_status="Shipped"`, `tracking_number="XYZ123"`.
5.  **LLM Inference (Child Span 3):** With the retrieved information, the agent constructs its final answer. This is where the core LLM inference happens. This span captures the *final prompt sent to the LLM*, the model used (e.g., `gpt-4o`), the **input tokens**, the **output tokens**, and the **latency** of the LLM call. Crucially, you embed context here: the retrieved product data, the order status.
6.  **Response Generation & Output (Final Child Span):** The agent processes the LLM's response, potentially applying some post-processing or formatting. This final step, before sending the answer back to the user, forms another span.
7.  **Complete Trace:** All these interconnected spans form a complete **distributed trace**. You can now visualize the entire journey: from the user's initial question, through multiple tool calls and LLM invocations, right up to the final answer. Each span holds key attributes like latency, token counts, and intermediate outputs. This trace is your ultimate debugging superpower.

This mental model lets you see not just *that* something went wrong, but *exactly where* in the multi-step process it failed, how long each part took, and what data flowed through it.

## Real-world use cases

This level of insight isn't just for debugging outages; it fundamentally changes how you build and optimize LLM systems.

*   **Debugging Complex Agent Chains:** When an agent takes a wrong turn, makes an incorrect tool call, or gets stuck in a loop, a trace immediately highlights the deviation. You can pinpoint which intermediate thought or action led to the error. This is invaluable for prompt engineering, function calling, and multi-agent system development.
*   **Cost Attribution & Optimization:** Every token costs money. With token counts attached to each LLM call within a trace, you can aggregate costs by user session, agent type, or even specific prompt templates. This lets you identify your most expensive flows and optimize them aggressively, perhaps by switching to smaller models for specific steps or refining prompts to reduce verbosity.
*   **Performance Bottleneck Identification:** Is your RAG retrieval taking too long? Is the LLM inference itself slow? Tracing shows you the latency of each component. This helps you identify whether you need faster vector databases, optimized API calls, or a different LLM provider.
*   **Hallucination Detection & Root Cause Analysis:** By instrumenting the confidence scores from NLI models (covered next), you can flag potential hallucinations directly within the trace. If a "hallucination detected" flag appears, you can immediately examine the preceding steps—the retrieved context, the prompt, the LLM output—to understand *why* the model might have diverged from facts.
*   **User Experience Analysis:** Tracing user-facing LLM interactions allows you to measure end-to-end latency, observe common user query patterns, and identify points of friction where the agent struggles to provide a satisfactory answer.

However, be careful where you apply this. Observability is not free.
*   **Anti-pattern: Instrumenting *every single internal function* in a monolithic, non-LLM backend just because you *can*.** If a specific service isn't performance-critical, doesn't interact with external systems in a complex way, or isn't part of a multi-step agent chain, over-instrumentation adds unnecessary overhead and noise to your traces. Focus on the *boundaries* of your LLM components and critical external dependencies.
*   **Anti-pattern: Capturing *excessively large data payloads* in span attributes.** Storing gigabytes of raw embeddings or entire documents in every trace span will quickly overwhelm your observability backend and lead to massive costs. Summarize, hash, or link to external storage for large data.

## Implementation & code

Let's look at how you'd instrument an LLM chain with OpenTelemetry in Python, capturing token counts and setting up for NLI-based hallucination detection. We'll contrast a naive approach with a robust, production-ready one.

First, the naive approach. This works fine for a simple script, but immediately breaks down in any multi-tenant, concurrent, or multi-step production environment.

```python
# NAIVE APPROACH: No tracing, manual token counting, no context
import os
import openai

def call_llm_naive(prompt: str) -> str:
    # No context propagation across calls, no clear way to link related actions.
    # Token counting is manual, scattered, and easy to miss.
    response = openai.chat.completions.create(
        model="gpt-3.5-turbo",
        messages=[{"role": "user", "content": prompt}]
    )
    # How do we know which user/session this cost belongs to? We don't.
    input_tokens = response.usage.prompt_tokens
    output_tokens = response.usage.completion_tokens
    print(f"LLM Call: Input Tokens={input_tokens}, Output Tokens={output_tokens}")
    return response.choices[0].message.content

# Imagine a complex agent calling this multiple times:
# Each call is an island, impossible to debug end-to-end.
```

This naive example is a black hole. You get an answer, you might get token counts, but you have zero visibility into *why* the prompt was chosen, *what* tools were called before it, or *who* initiated the whole thing. Good luck debugging that 2 AM pager call.

Now, for a robust, production-ready approach using **OpenTelemetry**. We'll set up the tracing, create spans, capture attributes (including tokens), and lay the groundwork for hallucination detection.

```python
# ROBUST PRODUCTION APPROACH: OpenTelemetry for tracing, token tracking, NLI integration
import os
import openai
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
from opentelemetry.instrumentation.openai import OpenAIInstrumentor # The magic for OpenAI auto-instrumentation
from opentelemetry.semconv.trace import SpanAttributes

# NLI Model for Hallucination Detection (simplified placeholder)
# In a real system, this would be a separate microservice or a fast local model
# like a distilled BERT or RoBERTa fine-tuned for NLI tasks.
# It takes a 'hypothesis' (LLM's generated statement) and 'premise' (retrieved context)
# and returns a probability of 'entailment', 'contradiction', or 'neutral'.
class NLIModel:
    def detect_hallucination(self, llm_response: str, retrieved_context: str) -> dict:
        # Placeholder for actual NLI inference.
        # A real NLI model might use a transformers library call:
        # classifier(premise=retrieved_context, hypothesis=llm_response)
        # For this example, let's just simulate some output.
        if "not found" in llm_response.lower() and "order shipped" in retrieved_context.lower():
            # Simulate a contradiction, potential hallucination
            return {"label": "contradiction", "score": 0.95}
        if "made up detail" in llm_response.lower():
             return {"label": "contradiction", "score": 0.88}
        return {"label": "entailment", "score": 0.99} # Default to no hallucination

# --- OpenTelemetry Setup (usually done once at application startup) ---
# Define a resource for your service, so traces are attributed correctly
resource = Resource.create({"service.name": "llm-agent-service", "service.version": "1.0.0"})
provider = TracerProvider(resource=resource)
# For local development, export spans to console. In production, use OTLP exporter to Jaeger/Grafana/Datadog
provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
trace.set_tracer_provider(provider)

# Auto-instrument OpenAI calls (critical for production robustness!)
# This automatically creates spans for OpenAI calls and captures basic metrics.
# We'll augment these with our own custom attributes.
OpenAIInstrumentor().instrument()

tracer = trace.get_tracer("llm-agent-tracer")
nli_detector = NLIModel()

# --- LLM Agent Component ---
def retrieve_context_from_db(query: str, parent_span) -> str:
    """Simulates RAG context retrieval from a database."""
    with tracer.start_as_current_span("retrieve_context", parent=parent_span) as span:
        span.set_attribute("query", query)
        # Simulate a DB call latency
        import time; time.sleep(0.05)
        context = f"Retrieved context for '{query}': The Quantum Flux Capacitor (product ID: QFC-101) was ordered on 2023-10-26 and shipped on 2023-10-27 with tracking XYZ123."
        span.set_attribute("retrieved_data_length", len(context))
        return context

def call_llm_with_tracing(prompt: str, retrieved_context: str, parent_span) -> str:
    """Calls the LLM with OpenTelemetry tracing and token tracking."""
    # The OpenAIInstrumentor creates a span around the actual API call.
    # We create our own span to wrap the *logic* of calling the LLM,
    # adding custom attributes that are relevant to our application.
    with tracer.start_as_current_span("llm_inference_step", parent=parent_span) as span:
        span.set_attribute("llm.model_name", "gpt-3.5-turbo")
        span.set_attribute("llm.prompt_text", prompt) # Capture the *final* prompt sent
        span.set_attribute("llm.retrieved_context", retrieved_context) # Link context to inference

        # OpenAIInstrumentor automatically adds:
        #   - llm.request.type: chat
        #   - llm.request.model: gpt-3.5-turbo
        #   - llm.response.model: gpt-3.5-turbo
        #   - llm.usage.prompt_tokens: <count>
        #   - llm.usage.completion_tokens: <count>
        #   - llm.usage.total_tokens: <count>
        #   - ... and other OpenAI specific attributes

        response = openai.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": f"Context: {retrieved_context}\n\nQuestion: {prompt}"}
            ]
        )
        llm_output = response.choices[0].message.content
        span.set_attribute("llm.output_text", llm_output)

        # Hallucination Detection step
        nli_result = nli_detector.detect_hallucination(llm_output, retrieved_context)
        span.set_attribute("llm.hallucination_detection.label", nli_result["label"])
        span.set_attribute("llm.hallucination_detection.score", nli_result["score"])
        if nli_result["label"] == "contradiction" and nli_result["score"] > 0.7:
            span.set_attribute("llm.hallucination_flag", True)
            span.set_attribute(SpanAttributes.STATUS_CODE, "ERROR") # Mark as error in trace
            span.set_attribute(SpanAttributes.STATUS_MESSAGE, "Potential Hallucination Detected")
        else:
            span.set_attribute("llm.hallucination_flag", False)

        return llm_output

def run_agent_workflow(user_query: str):
    """Main agent workflow, orchestrating steps within a root trace."""
    # This is the root span for the entire user request.
    with tracer.start_as_current_span("agent_workflow") as root_span:
        root_span.set_attribute("user_query", user_query)
        root_span.set_attribute("session_id", "user_123_session_abc") # Important for cost attribution

        # Step 1: Context Retrieval
        context = retrieve_context_from_db(user_query, root_span)

        # Step 2: LLM Inference with Hallucination Detection
        llm_answer = call_llm_with_tracing(user_query, context, root_span)

        print(f"\nAgent's Final Answer: {llm_answer}")

# --- Example Usage ---
if __name__ == "__main__":
    # Ensure OPENAI_API_KEY is set in your environment
    if not os.getenv("OPENAI_API_KEY"):
        print("Please set the OPENAI_API_KEY environment variable.")
        exit(1)

    print("Running a normal query...")
    run_agent_workflow("What is the status of my order for the Quantum Flux Capacitor?")

    print("\nRunning a query that might trigger a hallucination (simulated)...")
    run_agent_workflow("Tell me a made up detail about my order that isn't in the context.")
```

**Why this code is production-ready:**

*   **`OpenAIInstrumentor().instrument()`:** This single line is a game-changer. It automatically wraps all OpenAI API calls with OpenTelemetry spans, capturing default attributes like `llm.usage.total_tokens`, `llm.request.model`, etc. This prevents boilerplate and ensures consistent token tracking across all LLM interactions.
*   **`tracer.start_as_current_span(...)`:** We explicitly create spans for distinct logical steps (`agent_workflow`, `retrieve_context`, `llm_inference_step`). This creates a hierarchical trace, visually showing the flow and dependencies.
*   **`span.set_attribute(...)`:** We enrich each span with *application-specific context*. For `agent_workflow`, it's `user_query` and `session_id`. For `llm_inference_step`, it's the *final prompt* and the *retrieved context*. This is how you connect the dots between raw LLM outputs and the data that fed them.
*   **Cost Attribution:** By adding `session_id` or `user_id` to the root span, you can easily filter and aggregate total token costs per user or session in your observability dashboard.
*   **Hallucination Detection Integration:** The `nli_detector` is called *within* the `llm_inference_step` span. Its results (`label`, `score`) are immediately attached as attributes. If a contradiction is detected, we set `llm.hallucination_flag: True` and crucially, mark the span's `STATUS_CODE` as `ERROR`. This immediately flags the issue in your tracing system, making it trivial to find problem responses.
*   **Clear Boundaries:** Each function represents a clear step in the agent's logic, and each step has its own span, clearly defining its start, end, and associated data.

This setup gives you the complete story for every single request, something impossible with just scattered logs.

## Senior-level insights & gotchas

You've got the basics down, but as a principal engineer, you need to think beyond the happy path. Here's where the rubber meets the road:

*   **Sampling Strategies are Critical:** In high-volume systems, sending *every single trace* to your backend is a recipe for cost explosions. Implement intelligent **trace sampling**. You might sample 100% of traces for critical users or endpoints, 10% for general traffic, and 1% for background jobs. Or, use probabilistic sampling based on trace ID. More advanced: context-aware sampling where you only sample traces that contain a specific error flag (like our `llm.hallucination_flag`).
*   **Vendor Lock-in vs. OpenTelemetry:** OpenTelemetry is your defensive play against vendor lock-in. While vendors like LangChain, LlamaIndex, or even some LLM providers offer their own "observability" tools, they often push you into their ecosystem. OpenTelemetry is vendor-agnostic, meaning you can switch your observability backend (Jaeger, Grafana Tempo, Datadog, Honeycomb) without re-instrumenting your entire application. This is a strategic architectural decision.
*   **Latency Attribution Discrepancies:** Be wary of relying solely on LLM provider APIs for "total token cost" or "latency." The time reported by the API might not include network latency from your application to their endpoint, or the queueing time on their side. Your OpenTelemetry spans, which capture wall-clock time from *your* service's perspective, give you the most accurate *end-to-end* latency for your users.
*   **NLI Model Performance & Trade-offs:** The NLI model for hallucination detection isn't magic. It's an additional inference step, meaning added latency and cost.
    *   **False Positives/Negatives:** No NLI model is 100% accurate. You'll get false positives (flagging non-hallucinations) and false negatives (missing actual hallucinations). Tune your confidence threshold (`score > 0.7` in the example) carefully.
    *   **Model Choice:** Running a large NLI model like DeBERTa-v3-large for every LLM inference can be slow. Consider distilled versions or smaller, faster models, or only run NLI on a sample of requests, or for critical user flows.
    *   **Context Window Limitations:** NLI models have their own context window limitations. If your `retrieved_context` is massive, you might need to summarize it before feeding it to the NLI model.
*   **Sensitive Data Redaction:** Your traces *will* contain sensitive information (prompts, responses, retrieved data). Ensure your observability backend and any intermediate exporters are configured for proper **data redaction and anonymization** *before* data leaves your secure perimeter. This often means custom processors in your OpenTelemetry collector.
*   **Distributed Context Propagation:** When your agent workflow spans across multiple microservices (e.g., one service for RAG, another for tool execution, another for LLM inference), ensuring **trace context propagation** is paramount. OpenTelemetry makes this easy with auto-instrumentation for popular HTTP clients and message queues, but always verify it's working correctly across all service boundaries.

## Summary & production checklist

LLM observability is not just about catching errors; it's about understanding, optimizing, and building confidence in your AI systems. Embrace it, and your LLM applications will be significantly more robust and cost-efficient.

Here’s your copy-pasteable production checklist:

*   **Instrument with OpenTelemetry:** Use `opentelemetry-instrumentation` for popular libraries (e.g., `openai`).
*   **Create Meaningful Spans:** Wrap distinct logical steps (agent turns, tool calls, RAG retrievals, LLM inferences) in dedicated spans.
*   **Capture Key Attributes:**
    *   **LLM Metrics:** `llm.model_name`, `llm.prompt_text`, `llm.output_text`, `llm.usage.prompt_tokens`, `llm.usage.completion_tokens`, `llm.usage.total_tokens`.
    *   **Context:** `llm.retrieved_context` (or a hash/summary of it), `tool.name`, `tool.input_params`, `tool.output`.
    *   **Business Context:** `user_id`, `session_id`, `tenant_id`, `request_id`.
*   **Implement Hallucination Detection:** Integrate NLI models (or similar techniques) into your LLM inference spans, capturing `llm.hallucination_detection.label` and `score`. Set `STATUS_CODE: ERROR` for detected contradictions.
*   **Configure Trace Sampling:** Implement intelligent sampling strategies (e.g., head-based, probabilistic, or context-aware) to manage costs.
*   **Ensure Context Propagation:** Verify trace context flows correctly across all service boundaries (HTTP, message queues, gRPC).
*   **Redact Sensitive Data:** Configure OpenTelemetry processors or your observability backend to redact PII and sensitive information from traces.
*   **Visualize & Alert:** Set up dashboards in your observability platform (e.g., Grafana, Datadog, Honeycomb) to visualize traces, token usage, latency breakdowns, and create alerts for hallucination flags.
