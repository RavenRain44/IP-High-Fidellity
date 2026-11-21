# LuMaCo setup with Claude in Chrome

These prompts let Claude in Chrome do the dashboard clicking from [REAL_MODE_SETUP.md](REAL_MODE_SETUP.md) for you.

**How to use them**

1. Open Chrome, sign in to the Google account you want to own these services, and open the Claude in Chrome side panel.
2. Paste **one part at a time**, in order. Each part ends by printing a short "Report back" block; keep those.
3. Claude in Chrome will **stop and ask you** to do a few things itself it isn't allowed to: sign in, create accounts, approve access, and copy/paste secret keys. Do those, then reply "done".
4. When all parts are finished, paste the combined report back into Claude Code. It will finish the steps that run on your computer (saving the keys locally and creating the database tables).

> Part 4 (Cloudflare) needs the `app/` code on GitHub first. Ask Claude Code to commit and push before running it.

---

## Part 1 — Supabase project

````text
Help me set up a Supabase project for my web app "LuMaCo". Work in a new tab. Stop and ask me whenever a step needs me to sign in, create an account, approve something, or handle a password or secret key — never type those yourself.

1. Go to https://supabase.com/dashboard. If I'm not signed in, stop and ask me to sign in (or create a free account) myself.
2. Create a new project:
   - Organization: my personal/free organization (ask me if there's more than one).
   - Project name: lumaco
   - Database password: STOP. Ask me to click "Generate a password" and save it in my password manager myself.
   - Region: ask me which region is closest to my users (suggest the US region nearest me).
   - Plan: Free.
   Then wait until the project finishes provisioning (it can take a couple of minutes).
3. Open Project Settings → API (or "Data API" / "API Keys"). Note:
   - the Project URL (looks like https://xxxx.supabase.co)
   - the project reference ID (the "xxxx" part)
   Do NOT copy any key that is labeled "service_role" or "secret".
4. Go to Authentication → URL Configuration:
   - Site URL: https://lumaco.pages.dev
   - Add these Redirect URLs, one at a time, and save:
     http://localhost:5173/**
     https://lumaco.pages.dev/**
     https://*.lumaco.pages.dev/**
5. Go to Authentication → Sign In / Providers → Email:
   - Make sure "Confirm email" is ON.
   - Set the minimum password length to 8 if that setting is on this page (it may be under Authentication → Policies or Attack Protection instead; look there if not).
   - Save.
6. Finish by printing exactly this block, filled in:

REPORT BACK — SUPABASE
Project URL: <url>
Project ref: <ref>
Region: <region>
Site URL set: yes/no
Redirect URLs added: <list>
Confirm email on: yes/no
Min password length 8: yes/no/not found
Anything that didn't match these instructions: <notes>
````

After this part, copy the **anon / publishable key** yourself from Supabase (Project Settings → API Keys) — you'll paste it into Claude Code at the end. It's meant to be public, but keep the service_role / secret key private and never share it.

---

## Part 2 — Google sign-in

Replace `YOUR-PROJECT-REF` with the project ref from Part 1 before pasting.

````text
Help me set up "Sign in with Google" for my Supabase project. My Supabase project ref is YOUR-PROJECT-REF. Work in a new tab. Stop and ask me whenever a step needs me to sign in, accept terms, approve something, or handle a secret — never type or copy secrets yourself.

1. Go to https://console.cloud.google.com. If I'm not signed in, or Google asks me to accept terms of service, stop and let me do it.
2. Create a new project named LuMaCo (no organization is fine). Ask me before creating it, then switch to it.
3. Configure the OAuth consent screen (it may be under "Google Auth Platform" → Branding / Audience / Data Access):
   - App name: LuMaCo
   - User support email and developer contact email: ask me which email to use.
   - Audience / user type: External
   - Authorized domain: YOUR-PROJECT-REF.supabase.co
   - Publishing status: leave it in Testing.
   - Test users: ask me for the email addresses to add (at least mine).
   - Scopes: none beyond the defaults (email, profile, openid) for now.
4. Create an OAuth client (Credentials / Clients → Create client → OAuth client ID → Web application):
   - Name: LuMaCo web
   - Authorized JavaScript origins: http://localhost:5173 and https://lumaco.pages.dev
   - Authorized redirect URI: https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
   - Create it. Note the Client ID (it is not secret).
   - STOP at the client secret: tell me to copy it myself. Do not read it back to me or copy it.
5. Open https://supabase.com/dashboard/project/YOUR-PROJECT-REF/auth/providers and open the Google provider.
   - Turn it on.
   - You may paste the Client ID.
   - STOP and ask me to paste the Client Secret into the "Client Secret" field myself.
   - After I say done, save.
6. Print exactly this block, filled in:

REPORT BACK — GOOGLE
Google Cloud project: <name and project ID>
Consent screen: External, Testing, test users: <emails>
OAuth client ID: <client id>
Redirect URI added: yes/no
JavaScript origins added: <list>
Supabase Google provider enabled: yes/no (secret pasted by me)
Anything that didn't match these instructions: <notes>
````

---

## Part 3 — Microsoft sign-in

````text
Help me set up "Sign in with Microsoft" for my Supabase project. My Supabase project ref is YOUR-PROJECT-REF. Work in a new tab. Stop and ask me whenever a step needs me to sign in, create an account, approve something, or handle a secret — never type or copy secrets yourself.

1. Go to https://entra.microsoft.com. If I'm not signed in, stop and let me sign in (a personal Microsoft account works; if it asks to create a free Azure tenant or account, stop and let me decide).
2. Go to Identity / Entra ID → App registrations → New registration:
   - Name: LuMaCo
   - Supported account types: "Accounts in any organizational directory (any Microsoft Entra ID tenant – multitenant) and personal Microsoft accounts"
   - Redirect URI: platform "Web", value https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
   - Register.
3. On the app's Overview page, note the Application (client) ID (not secret).
4. Go to Certificates & secrets → Client secrets → New client secret:
   - Description: supabase
   - Expires: 24 months (or the longest offered)
   - Add it.
   - STOP: tell me to copy the secret's "Value" column myself right now (it is only shown once). Do not read it or copy it.
5. Go to API permissions and confirm "Microsoft Graph → User.Read" is present (it's added by default). Add the delegated permissions "email", "openid" and "profile" if they're missing. Do not grant admin consent unless I ask.
6. Open https://supabase.com/dashboard/project/YOUR-PROJECT-REF/auth/providers and open the Azure (Microsoft) provider.
   - Turn it on.
   - You may paste the Application (client) ID into "Application (client) ID".
   - STOP and ask me to paste the secret Value into "Secret Value" myself.
   - Leave "Azure Tenant URL" blank (so work, school and personal accounts can all sign in).
   - After I say done, save.
7. Print exactly this block, filled in:

REPORT BACK — MICROSOFT
App registration name: LuMaCo
Application (client) ID: <id>
Supported accounts: multitenant + personal: yes/no
Redirect URI added: yes/no
Client secret expires: <date> (value copied by me)
API permissions: <list>
Supabase Azure provider enabled: yes/no, tenant URL blank: yes/no
Anything that didn't match these instructions: <notes>
````

---

## Part 4 — Cloudflare Pages (run after the code is pushed to GitHub)

````text
Help me host my web app on Cloudflare Pages from its GitHub repository. Work in a new tab. Stop and ask me whenever a step needs me to sign in, create an account, authorize GitHub access, or handle a secret — never type those yourself.

1. Go to https://dash.cloudflare.com. If I'm not signed in, stop and let me sign in or create a free account.
2. Go to Workers & Pages → Create → Pages tab → "Connect to Git" (import an existing Git repository).
   - If Cloudflare asks to connect or authorize GitHub, STOP and let me approve it. Suggest I grant access to only the repository RavenRain44/IP-High-Fidellity.
3. Select the repository RavenRain44/IP-High-Fidellity and set:
   - Project name: lumaco
   - Production branch: main
   - Framework preset: None
   - Build command: npm run build
   - Build output directory: dist
   - Root directory (advanced): app
4. Environment variables (add them for Production; also Preview if offered separately):
   - VITE_SUPABASE_URL = <the Project URL from Part 1>  (you may type this one)
   - VITE_SUPABASE_ANON_KEY: STOP and ask me to paste the anon/publishable key myself.
5. Save and deploy. Wait for the first build to finish. If it fails, open the build log and tell me the first error line.
6. Open the deployed site (https://lumaco.pages.dev, or whatever *.pages.dev address Cloudflare assigned). Check that:
   - the LuMaCo sign-in page loads,
   - "Try the demo" opens the demo at /demo/.
   Do not create an account or sign in on the site.
7. Print exactly this block, filled in:

REPORT BACK — CLOUDFLARE
Pages project: lumaco
Site URL: <url>
Production branch: main
Build settings: root app, command npm run build, output dist: yes/no
Env vars set: VITE_SUPABASE_URL yes/no, VITE_SUPABASE_ANON_KEY yes/no (pasted by me)
First deploy: success/failed (<first error line if failed>)
Sign-in page loads: yes/no; /demo/ loads: yes/no
Anything that didn't match these instructions: <notes>
````

If Cloudflare gave you an address other than `https://lumaco.pages.dev`, tell Claude Code; the Supabase, Google and Microsoft redirect settings need that address added.

---

## Then, back in Claude Code

Paste all the report blocks plus your **anon / publishable key**, and say "finish the setup". Claude Code will:

1. save the URL and anon key in `app/.env.local` (git-ignored),
2. link the Supabase CLI and apply the database schema (`supabase db push`; you'll sign in to the Supabase CLI once and enter the database password from Part 1 yourself),
3. start the app locally and test sign-up, sign-in, onboarding and teams end to end.

Never paste the **service_role / secret** key, the database password, or the Google/Microsoft client secrets into a chat.
