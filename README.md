# bishalregmi.com.np

A minimalist technical portfolio and blog featuring automated AI-generated content pipeline. Built with modern web standards and free, zero-maintenance infrastructure.

## Overview

This project demonstrates a fully automated backend-focused blog and portfolio deployed to GitHub Pages, with:

- **Weekly AI-generated posts** via Google Gemini API
- **Automatic LinkedIn publishing** using LinkedIn's Consumer API
- **Static site generation** with Astro for optimal performance and SEO
- **Zero server maintenance** — everything runs on GitHub Actions and Pages

## Technology Stack

| Component | Technology | Benefit |
|-----------|-----------|---------|
| **Site** | Astro 5 | Fast static site generation with sitemap & RSS |
| **Hosting** | GitHub Pages | Free, zero-config deployment |
| **Content Generation** | Google Gemini 2.5 Flash | Free API tier, perpetual quota |
| **Publishing** | LinkedIn Consumer API | Direct posting to profile, no approval needed |
| **Automation** | GitHub Actions | Free workflow scheduling & CI/CD |

## Project Structure

```
site/                          # Astro portfolio + technical blog
├── src/content/blog/          # Blog post markdown files
├── src/pages/                 # Site pages (index, blog index, tags)
├── src/layouts/               # Astro layout components
└── public/                    # Static assets (CNAME, robots.txt, og-image.png)

automation/                    # Node.js automation scripts
├── scripts/
│   ├── generate-post.mjs      # AI blog post generator (Gemini)
│   ├── post-to-linkedin.mjs   # LinkedIn publisher
│   └── get-linkedin-refresh-token.mjs  # One-time auth helper
├── content-bank/
│   ├── topics.json            # 81 pre-curated backend topics
│   ├── used-topics.json       # Tracks rotation to avoid repeats
│   └── master-prompt.mjs      # Gemini system prompt
└── package.json

.github/workflows/             # CI/CD orchestration
├── deploy.yml                 # Build & deploy site on push
└── weekly-post.yml            # Generate & publish posts (Mondays 09:00 UTC)
```

## Features

### Automated Weekly Publishing

- **Scheduled**: Every Monday at 09:00 UTC
- **Manual trigger**: Run anytime via GitHub Actions UI
- **Smart topic rotation**: Avoids repeating topics until all 81 have been used once
- **Automatic LinkedIn sync**: Generated posts publish to your profile immediately

### Manual Post Publishing

Write and publish your own posts anytime:

1. Create a markdown file in `site/src/content/blog/` with frontmatter:
   ```markdown
   ---
   title: "Your Title"
   description: "Meta description (< 155 chars)"
   pubDate: 2026-07-10
   tags: ["postgresql", "backend"]
   category: "postgresql"
   draft: false
   aiAssisted: false
   readingTime: 6
   ---

   Your content in Markdown...
   ```

2. Commit and push to `main` — the deploy workflow picks it up automatically.

### SEO & Discoverability

- Automatic `sitemap-index.xml` generation
- RSS feed at `/rss.xml`
- Per-post JSON-LD `BlogPosting` schema
- Homepage `Person` schema
- Open Graph tags for social sharing
- Per-tag index pages

## Setup

See `SETUP_GUIDE.html` for detailed step-by-step instructions. Summary:

1. **Clone** this repository
2. **Push** to your own GitHub repo
3. **Set custom domain** DNS records (if using custom domain)
4. **Enable GitHub Pages** and set to use GitHub Actions as source
5. **Get API keys**:
   - Google Gemini (free tier, 1-minute setup)
   - LinkedIn Client ID & Secret (create app, request products)
6. **Add repository secrets**:
   - `GEMINI_API_KEY`
   - `LINKEDIN_CLIENT_ID`
   - `LINKEDIN_CLIENT_SECRET`
   - `LINKEDIN_REFRESH_TOKEN` (from local auth script)
   - `LINKEDIN_PERSON_URN` (from local auth script)
7. **Test** via GitHub Actions UI

Estimated setup time: 2–3 hours.

## Development

### Install dependencies

```bash
# Site
cd site && npm install

# Automation
cd automation && npm install
```

### Local development

```bash
# Run Astro dev server (http://localhost:3000)
cd site && npm run dev

# Build for production
cd site && npm run build
```

### Generate a post locally

```bash
export GEMINI_API_KEY=your_key_here
cd automation
npm run generate
```

### Get LinkedIn refresh token (one-time local setup)

```bash
export LINKEDIN_CLIENT_ID=your_id_here
export LINKEDIN_CLIENT_SECRET=your_secret_here
cd automation
npm run linkedin-auth
# Approve in browser, copy printed tokens to GitHub secrets
```

## GitHub Secrets Required

| Secret | Source | Rotation |
|--------|--------|----------|
| `GEMINI_API_KEY` | Google AI Studio (free tier) | Never (free tier is perpetual) |
| `LINKEDIN_CLIENT_ID` | LinkedIn app settings | Never (app credential) |
| `LINKEDIN_CLIENT_SECRET` | LinkedIn app settings | Never (app credential) |
| `LINKEDIN_REFRESH_TOKEN` | `npm run linkedin-auth` output | Annually (365-day expiry) |
| `LINKEDIN_PERSON_URN` | `npm run linkedin-auth` output | Never (your profile URN) |

## Workflow Schedules

### `deploy.yml`
- **Trigger**: Push to `main` branch
- **Purpose**: Build and deploy Astro site to GitHub Pages
- **Time**: ~1 minute

### `weekly-post.yml`
- **Trigger**: Every Monday at 09:00 UTC (via cron) or manual `Run workflow`
- **Purpose**: Generate AI post, publish to LinkedIn, commit back to repo
- **Time**: ~2–3 minutes

Modify the cron schedule in `weekly-post.yml` — see [crontab.guru](https://crontab.guru) for syntax.

## Customization

### Change the publication schedule

Edit `.github/workflows/weekly-post.yml`:
```yaml
schedule:
  - cron: '0 9 * * 1'  # Change this line
```

### Add or modify blog topics

Edit `automation/content-bank/topics.json` — add objects with `title`, `category`, and `focus` fields.

### Update portfolio content

Edit `site/src/pages/index.astro` to customize:
- Your name, bio, and tagline
- Tech stack
- Social links
- Open Graph image

## Cost

**$0/month, forever.**

- GitHub Pages: free hosting
- GitHub Actions: free workflow execution (up to 2,000 minutes/month for private repos)
- Gemini API: free tier includes 15 requests/minute (far more than one post per week)
- LinkedIn Consumer API: free tier supports posting to your own profile

No credit card, no expiration, no maintenance required beyond annual refresh token renewal.

## License

MIT — use this template as-is or customize it for your own blog.

## Support

For setup help, see `SETUP_GUIDE.html`. For technical details on each automation script, check comments in `automation/scripts/`.
