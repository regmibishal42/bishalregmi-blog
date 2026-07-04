// One-time helper. Run this LOCALLY (not in GitHub Actions) to obtain a
// LinkedIn refresh token you'll store as a GitHub secret. You only need to
// run this once — and again roughly once a year, since refresh tokens last
// 365 days.
//
// Prereqs (see SETUP_GUIDE for the click-by-click version):
//   1. Create an app at https://www.linkedin.com/developers/apps
//   2. Add the "Sign In with LinkedIn using OpenID Connect" and
//      "Share on LinkedIn" products to the app
//   3. Under Auth > OAuth 2.0 settings, add this exact redirect URL:
//      http://localhost:8787/callback
//   4. Copy your Client ID and Client Secret into a local .env file
//      (LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET) — never commit this file
//
// Usage: node scripts/get-linkedin-refresh-token.mjs

import http from 'http';
import { execSync } from 'child_process';

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8787/callback';
const SCOPE = 'openid profile w_member_social';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET env vars first.');
  process.exit(1);
}

const authUrl =
  `https://www.linkedin.com/oauth/v2/authorization?response_type=code` +
  `&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&state=setup`;

console.log('\nOpening this URL in your browser (copy it if it does not open automatically):\n');
console.log(authUrl + '\n');

try {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execSync(`${opener} "${authUrl}"`);
} catch {
  // Non-fatal — just copy-paste the URL above.
}

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/callback')) {
    res.end('Waiting for LinkedIn redirect...');
    return;
  }

  const url = new URL(req.url, 'http://localhost:8787');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`LinkedIn returned an error: ${error}`);
    console.error('LinkedIn auth error:', error);
    server.close();
    return;
  }

  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    res.end('Token exchange failed — check your terminal.');
    console.error('Token exchange failed:', tokenData);
    server.close();
    return;
  }

  res.end('Success! You can close this tab and go back to your terminal.');

  console.log('\n=== Save these as GitHub repo secrets ===\n');
  console.log('LINKEDIN_REFRESH_TOKEN =', tokenData.refresh_token);
  console.log('\n(Access token also issued, valid 60 days — the automation will refresh it automatically using the refresh token above, so you do not need to save the access token.)\n');

  // Also fetch and print the member URN you'll need for posting.
  const meRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });
  const me = await meRes.json();
  console.log('LINKEDIN_PERSON_URN =', `urn:li:person:${me.sub}`);
  console.log('\nAdd both of the above, plus LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET, as repo secrets.\n');

  server.close();
});

server.listen(8787, () => {
  console.log('Listening on http://localhost:8787 for the LinkedIn redirect...');
});
