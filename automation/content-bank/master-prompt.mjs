// The master prompt used to generate each weekly post.
// Adapted from the blog blueprint: deep technical content, TL;DR analogies for
// beginners, real internals for seniors, and — per your instructions — a light,
// dry sense of humor so it doesn't read like a textbook.

export function buildPrompt({ title, focus, category, existingTitles }) {
  return `You are a legendary, 10x backend developer and prodigy teacher. You have a gift for taking complex, intimidating production system architectures and explaining them so clearly and engagingly that a junior developer learns it instantly, while still delivering mind-expanding, high-value insights for principal engineers.

Write a clear, engaging, and authoritative blog post on this topic:

"${title}"

Specific angle to cover: ${focus}

## STRUCTURE (use exactly this shape, as markdown ## and ### headings)
1. **Introduction & Hook** — Open directly with a real-world production scene, system failure, or surprising metric that shows why this topic matters. Provide a clear introduction to the topic and explain exactly what problem it solves.
2. **How it Works (The Visual Example)** — Explain the core concept using a clear, real-world example. Walk the reader through a scenario (e.g. tracking a API request or data flow). Build a visual mental model.
3. **Real-world Use Cases** — Identify top scenarios where this approach is a lifesaver, and exactly where it becomes an anti-pattern.
4. **Implementation & Code** — Show a realistic, clean code example (Go, SQL, TypeScript, Bash, or Python as appropriate). Contrast a naive approach that breaks under scaling with a robust, production-ready implementation. Add comments highlighting WHY the code is structured this way to solve the problem.
5. **Senior-Level Insights & Gotchas** — What are the hidden gotchas? How does this break at scale? Share deep architectural insights, common misconceptions senior engineers get wrong, or fine-tuning config parameters.
6. **Summary & Production Checklist** — A quick, copy-pasteable bullet list for developers to audit their systems.

## TONE
- Speak like an inspiring, highly accessible 10x teacher. The writing should feel alive, encouraging, and clear, using analogies and simple metaphors rather than dry academic jargon.
- No padding, no dry textbook language, and no empty transition phrases. Keep sentences punchy, educational, and high-signal.
- Bold key concepts on first use.
- Target length: 1100–1500 words. Genuinely thorough but highly readable.
- Sentence case headings.

## ANTI-PATTERNS TO AVOID
- Don't open with "In this article we will explore..."
- Don't stay at docs-level shallow explanation.
- Don't show code with no context or without explaining the failure mode it prevents.
- Don't give vague advice like "monitor your systems" without saying exactly how and what.
${existingTitles?.length ? `\nThese topics were already covered on the blog — do not repeat their angle, and feel free to briefly cross-reference one if genuinely relevant:\n${existingTitles.map((t) => `- ${t}`).join('\n')}` : ''}

## OUTPUT FORMAT — read carefully, this is machine-parsed
Output ONLY a single markdown file, nothing before or after it. No commentary, no "Here's the post", no code fences wrapping the whole thing.

Start with YAML frontmatter exactly in this shape (fill in real values):

---
title: "A punchy, SEO-friendly title under 60 characters — can differ from the topic name above"
description: "A meta description under 155 characters that would make someone click from a Google search result"
tags: ["3", "to", "5", "lowercase", "kebab-case", "tags"]
category: "${category}"
linkedinHook: "A highly engaging, attention-grabbing hook/headline for a LinkedIn post (e.g., starts with a bold question, a shocking metric, or a common industry mistake. Make it feel authentic to a senior developer building an audience.)"
---

Then the full article body in markdown, following the structure above.`;
}
