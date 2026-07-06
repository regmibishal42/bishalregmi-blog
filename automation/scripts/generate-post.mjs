import { GoogleGenAI } from '@google/genai';
import matter from 'gray-matter';
import readingTime from 'reading-time';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { buildPrompt } from '../content-bank/master-prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BLOG_DIR = path.join(ROOT, 'site', 'src', 'content', 'blog');
const TOPICS_PATH = path.join(ROOT, 'automation', 'content-bank', 'topics.json');
const USED_PATH = path.join(ROOT, 'automation', 'content-bank', 'used-topics.json');

// Keep in sync with site/src/content/config.ts — the model doesn't know the
// zod schema, so anything it produces has to be clamped to it before we
// write a file, or the whole Astro build breaks on the next deploy.
const DESCRIPTION_MAX = 155;
const MAX_TOPIC_ATTEMPTS = 3; // distinct topics to try if one gets refused
const MAX_ATTEMPTS_PER_TOPIC = 3; // retries for transient errors on the same topic
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  const cut = str.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return base.trim() + '…';
}

// LinkedIn copy is meant to read like a person typed it, not a markdown
// file — strip stray formatting the model might slip in despite the prompt.
function cleanForLinkedIn(str) {
  if (!str) return '';
  return String(str)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\*\*?/g, '')
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTopic(excludeTitles) {
  const { topics, categories } = JSON.parse(readFileSync(TOPICS_PATH, 'utf-8'));
  const used = existsSync(USED_PATH) ? JSON.parse(readFileSync(USED_PATH, 'utf-8')) : { titles: [] };

  const notUsed = topics.filter((t) => !used.titles.includes(t.title));
  const pool = notUsed.length === 0 ? topics : notUsed;
  if (notUsed.length === 0) {
    console.log('All topics used — resetting rotation.');
    used.titles = [];
  }

  const candidates = pool.filter((t) => !excludeTitles.includes(t.title));
  const finalPool = candidates.length > 0 ? candidates : pool;

  const topic = finalPool[Math.floor(Math.random() * finalPool.length)];
  return { topic, categoryName: categories[topic.category], used };
}

function markTopicUsed(used, topic) {
  used.titles.push(topic.title);
  writeFileSync(USED_PATH, JSON.stringify(used, null, 2));
}

function extractRetryStatus(err) {
  if (typeof err?.status === 'number') return err.status;
  if (typeof err?.response?.status === 'number') return err.response.status;
  const match = /"code"\s*:\s*(\d{3})/.exec(err?.message ?? '');
  return match ? Number(match[1]) : undefined;
}

// One topic, with retries for rate limits / transient outages. Throws a
// typed-ish error (via .blocked) when Gemini actively refused the content,
// so the caller knows to try a *different* topic instead of hammering the
// same prompt into the same wall.
async function generateForTopic(ai, topic, categoryName) {
  const prompt = buildPrompt({
    title: topic.title,
    focus: topic.focus,
    category: categoryName,
    existingTitles: []
  });

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TOPIC; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });

      const candidate = response.candidates?.[0];
      const finishReason = candidate?.finishReason;

      if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
        const err = new Error(
          `Gemini declined to generate content for "${topic.title}" (finishReason=${finishReason}).`
        );
        err.blocked = true;
        throw err;
      }

      const text = (response.text ?? '').trim();
      if (!text) {
        const err = new Error(`Gemini returned an empty response for "${topic.title}".`);
        err.blocked = true;
        throw err;
      }

      return text;
    } catch (err) {
      lastError = err;

      if (err.blocked) throw err; // refusal — let the caller reroll the topic

      const status = extractRetryStatus(err);
      if (status && RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS_PER_TOPIC) {
        const backoffMs = 2000 * attempt;
        console.warn(`Attempt ${attempt}/${MAX_ATTEMPTS_PER_TOPIC} failed (HTTP ${status}): ${err.message}. Retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
        continue;
      }

      if (attempt < MAX_ATTEMPTS_PER_TOPIC) {
        console.warn(`Attempt ${attempt}/${MAX_ATTEMPTS_PER_TOPIC} failed: ${err.message}. Retrying...`);
        await sleep(1500 * attempt);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError;
}

// Tries up to MAX_TOPIC_ATTEMPTS distinct topics. A refusal on one topic
// (e.g. tripped a safety filter) rerolls to a fresh topic rather than
// retrying the exact same prompt forever.
async function generateContent(ai) {
  const attemptedTitles = [];
  let lastError;

  for (let i = 0; i < MAX_TOPIC_ATTEMPTS; i++) {
    const { topic, categoryName, used } = pickTopic(attemptedTitles);
    attemptedTitles.push(topic.title);
    console.log(`Attempt ${i + 1}/${MAX_TOPIC_ATTEMPTS}: generating post for "${topic.title}"`);

    try {
      const raw = await generateForTopic(ai, topic, categoryName);
      return { raw, topic, used };
    } catch (err) {
      lastError = err;
      console.warn(`Topic "${topic.title}" failed: ${err.message}`);
    }
  }

  throw new Error(
    `Exhausted ${MAX_TOPIC_ATTEMPTS} topic attempts without a usable response. Last error: ${lastError?.message}`
  );
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const ai = new GoogleGenAI({ apiKey });

  // Nothing is written to disk until we have a fully validated post, so any
  // failure above this point leaves zero partial state — the workflow step
  // simply fails and nothing downstream (commit, deploy, LinkedIn) runs.
  const { raw: rawResponse, topic, used } = await generateContent(ai);

  let raw = rawResponse.replace(/^```(markdown|md)?\n/, '').replace(/\n```$/, '');

  const parsed = matter(raw);
  if (!parsed.data.title || !parsed.data.description || !parsed.content.trim()) {
    throw new Error('Model output was missing a title, description, or body. Raw output:\n' + raw.slice(0, 500));
  }

  const slug = slugify(parsed.data.title);
  const filePath = path.join(BLOG_DIR, `${slug}.md`);

  if (existsSync(filePath)) {
    throw new Error(`A post with slug "${slug}" already exists. Aborting to avoid overwrite.`);
  }

  const stats = readingTime(parsed.content);
  const today = new Date().toISOString().slice(0, 10);

  const description = truncate(String(parsed.data.description).trim(), DESCRIPTION_MAX);
  const tags = Array.isArray(parsed.data.tags) && parsed.data.tags.length > 0
    ? parsed.data.tags.map(String)
    : [topic.category];

  const frontmatter = {
    title: String(parsed.data.title).trim(),
    description,
    pubDate: today,
    tags,
    category: topic.category,
    draft: false,
    aiAssisted: true,
    readingTime: Math.ceil(stats.minutes),
    linkedinHook: cleanForLinkedIn(parsed.data.linkedinHook),
    linkedinBody: cleanForLinkedIn(parsed.data.linkedinBody)
  };

  if (!existsSync(BLOG_DIR)) mkdirSync(BLOG_DIR, { recursive: true });

  const output = matter.stringify(parsed.content.trim() + '\n', frontmatter);
  writeFileSync(filePath, output);

  markTopicUsed(used, topic);

  console.log(`Wrote ${filePath}`);

  const summary = {
    title: frontmatter.title,
    description: frontmatter.description,
    slug,
    url: `https://bishalregmi.com.np/blog/${slug}/`,
    linkedinHook: frontmatter.linkedinHook,
    linkedinBody: frontmatter.linkedinBody
  };
  writeFileSync(path.join(ROOT, 'automation', 'latest-post.json'), JSON.stringify(summary, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `post_url=${summary.url}\npost_title=${summary.title}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error('Blog post generation failed:', err.message);
  console.error('No file was written — nothing will be committed, deployed, or posted to LinkedIn this run.');
  process.exit(1);
});
