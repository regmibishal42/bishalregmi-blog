# bishalregmi.com.np

Minimalist portfolio + technical blog, with a weekly AI-generated post pipeline.

## Layout

```
site/         Astro site — the portfolio + blog itself (this is what deploys to GitHub Pages)
automation/   Node scripts that generate a post via Gemini and publish it to LinkedIn
.github/workflows/
  deploy.yml        builds + deploys site/ on every push to main
  weekly-post.yml    runs every Monday (and on-demand) to generate + publish a post
```

## Writing a post yourself

Drop a markdown file into `site/src/content/blog/` following the frontmatter shape in
`site/src/content/config.ts`, set `aiAssisted: false`, commit, and push. `deploy.yml`
picks it up automatically — no need to touch the automation folder at all.

Or, from the GitHub Actions tab, run "Weekly AI blog post" manually any time via
"Run workflow" — you're not limited to the Monday schedule.

See `SETUP_GUIDE.html` for full step-by-step setup instructions.
# bishalregmi-blog
