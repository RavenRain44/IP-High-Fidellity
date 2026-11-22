# LuMaCo real mode: architecture and rollout

LuMaCo now has two modes on one site:

- **Demo mode** (`/demo/`): the existing prototype in `frontend/`, unchanged. Fictional data in the browser, simulated integrations. Reached from the welcome page with **Try the demo**.
- **Normal mode** (`/`): the real product in `app/`. Real accounts, a real database, real integrations, real recording.

## Decisions

| Area | Choice | Why |
| --- | --- | --- |
| Frontend | React + TypeScript + Vite (`app/`), LuMaCo design tokens copied from the demo | Clean base for real data and security; the demo's layered scripts stay untouched |
| Auth, database, storage, server code | Supabase (Postgres, Auth, Storage, Edge Functions) | Free tier, row-level security enforces privacy in the database itself |
| Website hosting | Cloudflare Pages (`lumaco-bvs.pages.dev`, custom domain later) | Free, global CDN, builds from GitHub |
| Mobile | Installable web app (PWA) from the same site | Free, no app stores; same codebase |
| Sign-in | Google, Microsoft, email + password | Google/Microsoft sign-in is also the path to connecting Gmail/Outlook |
| Email + calendar | Gmail + Google Calendar; Outlook + calendar via Microsoft Graph | First release |
| Speech-to-text | Deepgram (speaker labels) | About $0.26 per audio hour; $200 starter credit |
| Notes, contacts, promises | Claude via the Anthropic API, called only from Edge Functions | Replaces the demo's rule-based extraction |
| Phone calls / SMS | Twilio business number (calls forwarded/recorded, SMS sent/received through it) | The only reliable way; phones don't let apps read normal call logs or texts |
| Meetings | Record in-person and phone meetings on the computer or phone | Builds on the demo's Capture flow |

## Accounts and teams

- Anyone can create a **standalone individual account** (personal workspace).
- A user can **create a team** (company). The creator is its owner.
- Owners/managers **invite** existing or new users by email. Joining a team never moves personal records: they stay in the personal workspace.
- Roles: `owner`, `manager`, `member`.
- Each record has a workspace (`personal` or a team) and a visibility: `private` (only the author), `managers` (author + team managers/owners), `team` (all team members).
- Rules enforced by Postgres row-level security, not just the UI:
  - private records are only ever readable by their author;
  - manager metrics and AI summaries read only `team`/`managers` records;
  - leaving a team removes access to that team's records immediately.

## Data model (first migration)

`profiles`, `teams`, `team_members`, `team_invites`, `companies`, `contacts` (+ `contact_identities` for verified emails/phones), `projects` (+ `project_contacts`), `interactions` (email, call, text, meeting, calendar, note; with source + provenance), `meetings` (transcript, AI notes, reviewed flag), `promises`, `integration_connections` (status and scopes only; tokens live in a server-only table), `audit_events`.

## Integrations: how each one works

| Integration | Flow | Server pieces |
| --- | --- | --- |
| Google | OAuth with `gmail.readonly` + `calendar.readonly`; refresh token stored server-side | `oauth-google` callback, `sync-google` (Gmail history + Calendar incremental sync), Gmail push via Pub/Sub later |
| Microsoft | OAuth (Microsoft identity platform) with `Mail.Read`, `Calendars.Read`, `offline_access` | `oauth-microsoft` callback, `sync-microsoft` (Graph delta queries), Graph change notifications later |
| Recording | Browser/phone microphone → upload to private Storage bucket → transcribe → delete audio by default | `transcribe` (Deepgram), `extract-notes` (Claude) |
| Twilio | Buy a number; inbound/outbound calls bridged and recorded with consent prompt; SMS webhooks | `twilio-voice`, `twilio-sms` webhooks |

Only **approved contacts** create relationship history, promises or reports (product rule). Everything else is sorted but not tracked.

## Rollout

1. **Foundation** (this change): `app/` scaffold, welcome/sign-in/sign-up/reset/onboarding, app shell, teams + invites UI, database schema + RLS, demo at `/demo/`, PWA, Cloudflare config, setup guide.
2. **Contacts and capture**: real contacts/companies/projects CRUD, Capture panel with real recording, Deepgram transcription, Claude note extraction, review screen, project files.
3. **Google + Microsoft**: OAuth connect/disconnect, initial sync, incremental sync, approved-contact matching, Needs Attention + Open Promises from real data. *Google is built (`google-connect`, `google-sync`, migration `20261123000000_google.sql`); Microsoft is next.*
4. **Twilio**: business number, call recording with consent, SMS, call-duration engagement rule (>2:00).
5. **Teams**: manager view from shared records only, source-coverage reporting, audit trail, undo.
6. **Hardening**: Playwright tests, error monitoring, data export/delete, privacy policy and terms, provider verification.

## Things that need you (accounts and approvals)

See `docs/REAL_MODE_SETUP.md` for step-by-step instructions. You create these accounts yourself, and set the secret keys yourself; nothing secret goes into the repo.

1. Supabase project (free)
2. Cloudflare account (free) connected to the GitHub repo
3. Google Cloud project with an OAuth client (free)
4. Microsoft Entra (Azure) app registration (free)
5. Deepgram API key ($200 free credit)
6. Anthropic API key (pay as you go)
7. Twilio account and number (about $1.15/month per number plus per-minute/message usage)

## Limits to know before launch

- **Gmail**: `gmail.readonly` is a *restricted* scope. In Google's "testing" mode, up to 100 named test users can connect right away. Going public requires Google's verification and an annual third-party security assessment (CASA), which can cost money. Calendar-only is a *sensitive* scope with a lighter review.
- **Microsoft**: personal Outlook accounts work immediately. Many company tenants require an IT admin to approve the app; publisher verification makes this smoother.
- **Twilio/US texting**: business SMS to US numbers requires A2P 10DLC brand and campaign registration (small one-time and monthly fees) before messages deliver reliably.
- **Recording consent**: some US states require all-party consent. The app asks for a consent confirmation before every recording and plays/announces it on Twilio calls.
- **PWA on iPhone**: recording works while the app is open; iOS does not allow recording in the background from a web app.
- **Free tiers**: Supabase free projects pause after a week of inactivity and have 500 MB database / 1 GB storage limits. Fine for a pilot; upgrade ($25/month) before real customers.
