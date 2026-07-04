import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // When using a custom domain, set `site` to the custom domain and keep
  // `base` as '/' so assets are served from the site root. If you prefer to
  // host at the GitHub Pages path (username.github.io/repo), change these
  // values accordingly.
  site: 'https://bishalregmi.com.np',
  base: '/',
  integrations: [sitemap()],
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
      wrap: true
    }
  }
});
