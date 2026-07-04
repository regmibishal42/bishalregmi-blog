// Posts the latest generated post to LinkedIn using the free Consumer API
// tier (w_member_social scope). Refreshes the access token from the stored
// refresh token on every run, so no manually-copied access token ever goes
// stale mid-week.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const {
  LINKEDIN_CLIENT_ID,
  LINKEDIN_CLIENT_SECRET,
  LINKEDIN_REFRESH_TOKEN,
  LINKEDIN_PERSON_URN,
  LINKEDIN_ACCESS_TOKEN
} = process.env;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function refreshAccessToken() {
  // If a temporary access token is supplied (short-lived, ~60 days), use it.
  if (LINKEDIN_ACCESS_TOKEN) return LINKEDIN_ACCESS_TOKEN;

  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: requireEnv('LINKEDIN_REFRESH_TOKEN', LINKEDIN_REFRESH_TOKEN),
      client_id: requireEnv('LINKEDIN_CLIENT_ID', LINKEDIN_CLIENT_ID),
      client_secret: requireEnv('LINKEDIN_CLIENT_SECRET', LINKEDIN_CLIENT_SECRET)
    })
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`LinkedIn token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function buildPostText({ title, description, url, linkedinHook }) {
  const hook = linkedinHook ? `${linkedinHook}\n` : `🚀 New Blog Post: ${title}\n`;
  return `${hook}\n${description}\n\nRead the full deep dive here ⬇️\n${url}\n\n#backend #softwareengineering #buildinpublic`;
}

async function main() {
  const latestPath = path.join(ROOT, 'automation', 'latest-post.json');
  const post = JSON.parse(readFileSync(latestPath, 'utf-8'));

  const accessToken = await refreshAccessToken();
  const personUrn = requireEnv('LINKEDIN_PERSON_URN', LINKEDIN_PERSON_URN);

  const body = {
    author: personUrn,
    commentary: buildPostText(post),
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': '202601',
      'X-Restli-Protocol-Version': '2.0.0'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LinkedIn post failed (${res.status}): ${errText}`);
  }

  console.log(`Posted to LinkedIn: ${post.title}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
