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

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function pickTopic() {
  const { topics, categories } = JSON.parse(readFileSync(TOPICS_PATH, 'utf-8'));
  const used = existsSync(USED_PATH) ? JSON.parse(readFileSync(USED_PATH, 'utf-8')) : { titles: [] };

  let remaining = topics.filter((t) => !used.titles.includes(t.title));
  if (remaining.length === 0) {
    console.log('All topics used — resetting rotation.');
    used.titles = [];
    remaining = topics;
  }

  const topic = remaining[Math.floor(Math.random() * remaining.length)];
  return { topic, categoryName: categories[topic.category], used };
}

function markTopicUsed(used, topic) {
  used.titles.push(topic.title);
  writeFileSync(USED_PATH, JSON.stringify(used, null, 2));
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is not set.');

  const { topic, categoryName, used } = pickTopic();
  console.log(`Selected topic: ${topic.title}`);

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildPrompt({
    title: topic.title,
    focus: topic.focus,
    category: categoryName,
    existingTitles: []
  });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt
  });

  let raw = response.text.trim();
  // Strip accidental ```markdown fences if the model wraps the whole output.
  raw = raw.replace(/^```(markdown|md)?\n/, '').replace(/\n```$/, '');

  const parsed = matter(raw);
  if (!parsed.data.title) {
    throw new Error('Model output did not include valid frontmatter. Raw output:\n' + raw.slice(0, 500));
  }

  const slug = slugify(parsed.data.title);
  const filePath = path.join(BLOG_DIR, `${slug}.md`);

  if (existsSync(filePath)) {
    throw new Error(`A post with slug "${slug}" already exists. Aborting to avoid overwrite.`);
  }

  const stats = readingTime(parsed.content);
  const today = new Date().toISOString().slice(0, 10);

  const frontmatter = {
    title: parsed.data.title,
    description: parsed.data.description,
    pubDate: today,
    tags: parsed.data.tags || [topic.category],
    category: topic.category,
    draft: false,
    aiAssisted: true,
    readingTime: Math.ceil(stats.minutes),
    linkedinHook: parsed.data.linkedinHook || ''
  };

  if (!existsSync(BLOG_DIR)) mkdirSync(BLOG_DIR, { recursive: true });

  const output = matter.stringify(parsed.content.trim() + '\n', frontmatter);
  writeFileSync(filePath, output);

  markTopicUsed(used, topic);

  console.log(`Wrote ${filePath}`);

  // Hand off details to the next step (LinkedIn posting) via GitHub Actions outputs.
  const summary = {
    title: frontmatter.title,
    description: frontmatter.description,
    slug,
    url: `https://bishalregmi.com.np/blog/${slug}/`,
    linkedinHook: frontmatter.linkedinHook
  };
  writeFileSync(path.join(ROOT, 'automation', 'latest-post.json'), JSON.stringify(summary, null, 2));

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `post_url=${summary.url}\npost_title=${summary.title}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
