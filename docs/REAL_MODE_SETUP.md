# Setting up LuMaCo normal mode

You create these accounts yourself; LuMaCo's code never needs your passwords. Secret keys go into
the provider dashboards or local `.env` files that git ignores, never into the repository.

Prefer to have Claude in Chrome do the dashboard clicking? Use the paste-ready prompts in
[CLAUDE_IN_CHROME_SETUP.md](CLAUDE_IN_CHROME_SETUP.md).

Steps 1–3 make sign-in, sign-up and teams work. Steps 4–6 are needed when the integrations are built.

## 1. Supabase (database, sign-in, storage) — free

1. Create an account at <https://supabase.com> and a new project named `lumaco`. Pick the region closest to your users and save the database password somewhere safe.
2. In **Project Settings → API**, copy the **Project URL** and the **anon / publishable key**.
3. In this repo, copy `app/.env.example` to `app/.env.local` and paste those two values.
4. Apply the database schema from the repo root:
   ```bash
   supabase login
   ```
   ```bash
   supabase link --project-ref YOUR-PROJECT-REF
   ```
   ```bash
   supabase db push
   ```
5. In **Authentication → URL Configuration**, set:
   - **Site URL**: `https://lumaco.pages.dev` (or your custom domain later)
   - **Redirect URLs**: `http://localhost:5173/**`, `https://lumaco.pages.dev/**`, `https://*.lumaco.pages.dev/**`
6. In **Authentication → Sign In / Providers → Email**, keep **Confirm email** on and set the minimum password length to 8.
7. Free projects send only a few auth emails per hour. Before inviting real users, add your own SMTP in **Authentication → Emails → SMTP Settings** (e.g. Resend's free tier).

Run it locally:

```bash
npm --prefix app install
```
```bash
npm --prefix app run dev
```

Then open <http://localhost:5173>. Email sign-up works now; Google and Microsoft need steps 2 and 3.

## 2. Google sign-in — free

1. At <https://console.cloud.google.com>, create a project named `LuMaCo`.
2. **APIs & Services → OAuth consent screen**: External, app name `LuMaCo`, your support email, and your Supabase domain (`YOUR-PROJECT-REF.supabase.co`) under authorized domains. Leave it in **Testing** and add yourself and pilot users as test users.
3. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized JavaScript origins: `http://localhost:5173`, `https://lumaco.pages.dev`
   - Authorized redirect URI: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
4. In Supabase **Authentication → Sign In / Providers → Google**, enable it and paste the client ID and secret.

The Gmail and Calendar integration will reuse this Google project (adding the Gmail and Calendar APIs and scopes).

## 3. Microsoft sign-in — free

1. At <https://entra.microsoft.com>, go to **App registrations → New registration**, name `LuMaCo`.
2. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
3. Redirect URI (Web): `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`.
4. **Certificates & secrets → New client secret**; copy the secret's **Value** (shown once).
5. In Supabase **Authentication → Sign In / Providers → Azure**, enable it, paste the Application (client) ID and the secret, and leave **Azure Tenant URL** blank so work, school and personal accounts can all sign in.

## 4. Cloudflare Pages (website hosting) — free

1. Create an account at <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Pages → Connect to Git**, choose this GitHub repository.
3. Build settings:
   - Framework preset: **None**
   - Root directory: `app`
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Environment variables (Production and Preview): `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (same values as `app/.env.local`).
5. Name the project `lumaco` so the site is `https://lumaco.pages.dev`. Every pull request gets its own preview URL.

The build serves the real app at `/` and the demo at `/demo/`. The existing GitHub Pages workflow keeps publishing the demo on its own; it can be retired once Cloudflare is live.

## 5. Install on phones (installable web app)

No app store needed. Once deployed:

- **iPhone**: open the site in Safari → Share → **Add to Home Screen**.
- **Android**: open in Chrome → menu → **Install app**.

## 6. Accounts for the integrations (later phases)

| Service | What to create | Cost |
| --- | --- | --- |
| Deepgram | <https://console.deepgram.com>: an API key | $200 free credit, then ~$0.26 per audio hour |
| Anthropic | <https://console.anthropic.com>: an API key | Pay per use |
| Twilio | <https://www.twilio.com>: account + a phone number; US texting also needs A2P 10DLC registration | ~$1.15/month per number + usage |

These keys are stored as Supabase Edge Function secrets (`supabase secrets set NAME=value`), never in the browser or the repo.
