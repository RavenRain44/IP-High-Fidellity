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
   - Site URL: https://lumaco-bvs.pages.dev
   - Add these Redirect URLs, one at a time, and save:
     http://localhost:5173/**
     https://lumaco-bvs.pages.dev/**
     https://*.lumaco-bvs.pages.dev/**
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
   - Authorized JavaScript origins: http://localhost:5173 and https://lumaco-bvs.pages.dev
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
6. Open the deployed site (https://lumaco-bvs.pages.dev, or whatever *.pages.dev address Cloudflare assigned). Check that:
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

If Cloudflare gave you an address other than `https://lumaco-bvs.pages.dev`, tell Claude Code; the Supabase, Google and Microsoft redirect settings need that address added.

---

## Part 5 — Use the real site address and apply database access rules

Cloudflare assigned `https://lumaco-bvs.pages.dev` (the name `lumaco.pages.dev` was taken), so the
sign-in redirect settings from Parts 1–2 need that address. The prompt also runs one small database
update that newer Supabase projects need. My Supabase project ref is in the prompt below; replace it
if yours differs.

````text
Help me finish configuring my web app LuMaCo. My Supabase project ref is czdfwbgfncdqqaxwcicg and my live site is https://lumaco-bvs.pages.dev. Work in a new tab. Stop and ask me whenever a step needs me to sign in, approve something, or handle a password or secret — never type those yourself.

1. Open https://supabase.com/dashboard/project/czdfwbgfncdqqaxwcicg/auth/url-configuration
   - Set Site URL to https://lumaco-bvs.pages.dev and save.
   - In Redirect URLs, remove any entries containing "lumaco.pages.dev" (without "-bvs"), and make sure exactly these are present, then save:
     http://localhost:5173/**
     https://lumaco-bvs.pages.dev/**
     https://*.lumaco-bvs.pages.dev/**
2. Open https://console.cloud.google.com/apis/credentials (project LuMaCo), open the OAuth client "LuMaCo web":
   - Under Authorized JavaScript origins, replace https://lumaco.pages.dev with https://lumaco-bvs.pages.dev (keep http://localhost:5173).
   - Leave the redirect URI (the supabase.co callback) unchanged. Save.
3. Open https://supabase.com/dashboard/project/czdfwbgfncdqqaxwcicg/sql/new
   - Before running anything, show me the SQL below and ask me to confirm. Then paste exactly this SQL into the editor and click Run:

-- Explicit privileges for the Data API.
--
-- Newer Supabase projects no longer grant the anon/authenticated roles access to new tables
-- automatically, so every table needs explicit grants. Row-level security (foundation
-- migration) still decides which rows each user sees; these grants only decide which
-- operations are possible at all. Signed-out visitors (anon) get nothing.

revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;

-- Workspace records: full CRUD, filtered by RLS.
grant select, insert, update, delete on
  public.companies, public.contacts, public.contact_identities,
  public.projects, public.project_contacts,
  public.interactions, public.meetings, public.meeting_contacts,
  public.promises
to authenticated;
grant select, insert on public.audit_events to authenticated;

-- Accounts and teams.
grant select, update on public.profiles to authenticated;
grant select, update, delete on public.teams to authenticated;        -- created via create_team()
grant select, update, delete on public.team_members to authenticated; -- joined via accept_invite()
grant select, insert, update on public.team_invites to authenticated;

-- Integrations: users can see and disconnect their own; tokens are server-only.
grant select, delete on public.integration_connections to authenticated;
revoke all on public.integration_secrets from authenticated;

-- Server code (Edge Functions) uses the service role, which bypasses RLS but still needs
-- table privileges on strict projects.
grant all on all tables in schema public to service_role;

-- Functions: RLS helpers must be callable by signed-in users because policies call them.
grant execute on function
  public.team_role_of(uuid), public.is_team_member(uuid), public.is_team_admin(uuid),
  public.can_read(uuid, uuid, public.visibility), public.can_write_scope(uuid),
  public.create_team(text), public.my_invites(), public.accept_invite(uuid)
to authenticated;
grant execute on all functions in schema public to service_role;

-- Keep future tables and functions locked down by default too.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated, public;

   - If Supabase warns that the query contains destructive operations (it may, because of the "revoke" lines), tell me and wait for me to confirm.
   - Report the result message, or the first error line.
4. Print exactly this block, filled in:

REPORT BACK — ADDRESS + ACCESS
Supabase Site URL: <value>
Supabase Redirect URLs: <list>
Google JavaScript origins: <list>
SQL run: success/failed (<message or first error line>)
Anything that didn't match these instructions: <notes>
````

---

## Part 6 — Meeting capture: database update and AI keys

Turns on real recording, transcription and AI notes. You'll create two API keys yourself and paste
them straight into Supabase; Claude in Chrome never sees them.

Costs: Deepgram gives $200 of free credit (about $0.26 per hour of audio after that). Anthropic is
pay as you go; drafting notes for a one-hour meeting costs roughly 10–25 cents.

````text
Help me finish setting up meeting capture for my app LuMaCo. My Supabase project ref is czdfwbgfncdqqaxwcicg. Work in a new tab. Stop and ask me whenever a step needs me to sign in, create an account, accept terms, enter payment details, or handle an API key or password — never type, read back, or copy those yourself.

1. Database update. Open https://supabase.com/dashboard/project/czdfwbgfncdqqaxwcicg/sql/new
   - Show me the SQL below and ask me to confirm, then paste exactly this SQL into the editor and click Run:

-- Phase 2: meeting capture. A recording or typed note is processed by the process-meeting
-- Edge Function (Deepgram transcript + Claude draft), then the author reviews and files it
-- with finalize_meeting(). Nothing reaches contacts, promises or timelines before review.

alter table public.meetings
  add column typed_notes text,
  add column keep_audio  boolean not null default false,
  add column speakers    jsonb,   -- [{label: "Speaker 1", name: "Sarah Mitchell" | null}]
  add column suggestions jsonb;   -- the AI draft: title, notes, contact_ids, project_id, promises, why

-- Contacts named in a filed meeting are looked up by this.
create index meeting_contacts_contact_idx on public.meeting_contacts (contact_id);
create index promises_contact_idx on public.promises (contact_id) where contact_id is not null;
create index interactions_project_idx on public.interactions (project_id) where project_id is not null;
create index meetings_project_idx on public.meetings (project_id) where project_id is not null;

-- File a reviewed meeting in one transaction. SECURITY INVOKER: every statement runs under
-- the caller's row-level security, so it can only touch the caller's meeting and only link
-- contacts/projects the caller can read.
create function public.finalize_meeting(
  p_meeting     uuid,
  p_title       text,
  p_notes       text,
  p_transcript  text,
  p_contact_ids uuid[],
  p_project_id  uuid,
  p_team_id     uuid,
  p_visibility  public.visibility,
  p_promises    jsonb            -- [{title, direction, due_on, contact_id, evidence}]
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  m        public.meetings;
  vis      public.visibility := case when p_team_id is null then 'private' else coalesce(p_visibility, 'private') end;
  proj     uuid;
  readable uuid[];
  pr       jsonb;
  pr_contact uuid;
  first_line text;
begin
  select * into m from public.meetings where id = p_meeting and owner_id = auth.uid();
  if not found then raise exception 'Meeting not found'; end if;
  if p_team_id is not null and not public.is_team_member(p_team_id) then
    raise exception 'You are not a member of that team';
  end if;

  -- Only contacts and a project the caller can actually see.
  select coalesce(array_agg(c.id), '{}') into readable from public.contacts c where c.id = any(coalesce(p_contact_ids, '{}'));
  select p.id into proj from public.projects p where p.id = p_project_id;

  update public.meetings set
    title           = coalesce(nullif(btrim(p_title), ''), m.title, 'Meeting'),
    notes           = p_notes,
    transcript_text = coalesce(p_transcript, m.transcript_text),
    project_id      = proj,
    team_id         = p_team_id,
    visibility      = vis,
    status          = 'reviewed',
    reviewed_at     = now()
  where id = m.id;

  delete from public.meeting_contacts where meeting_id = m.id;
  insert into public.meeting_contacts (meeting_id, contact_id) select m.id, unnest(readable);

  -- One timeline entry per person; re-filing updates it instead of duplicating.
  first_line := left(split_part(coalesce(p_notes, ''), E'\n', 1), 500);
  if first_line ~* '^summary\s*$' then
    first_line := left(split_part(coalesce(p_notes, ''), E'\n', 2), 500);
  end if;
  insert into public.interactions (team_id, visibility, contact_id, project_id, kind, occurred_at, title, summary,
                                   source, source_ref, duration_sec, qualifies_engagement)
  select p_team_id, vis, cid, proj, case when m.kind = 'notes' then 'note' else 'meeting' end, m.started_at,
         coalesce(nullif(btrim(p_title), ''), 'Meeting'), first_line, 'recording', m.id::text || ':' || cid::text,
         m.duration_sec, m.kind in ('meeting', 'call')
  from unnest(readable) as cid
  on conflict (owner_id, source, source_ref) where source_ref is not null
  do update set title = excluded.title, summary = excluded.summary, project_id = excluded.project_id,
                team_id = excluded.team_id, visibility = excluded.visibility;

  -- A recorded meeting or call is two-way engagement (product rule). Only the caller's own
  -- contacts are updated here; RLS blocks edits to records other people own.
  if m.kind in ('meeting', 'call') then
    update public.contacts set last_engagement_at = greatest(coalesce(last_engagement_at, m.started_at), m.started_at)
    where id = any(readable) and owner_id = auth.uid();
  end if;

  -- Promises the author approved. Re-filing replaces this meeting's still-open promises.
  delete from public.promises where source = 'meeting' and source_ref = m.id::text and status = 'open' and owner_id = auth.uid();
  for pr in select * from jsonb_array_elements(coalesce(p_promises, '[]'::jsonb)) loop
    continue when coalesce(btrim(pr ->> 'title'), '') = '';
    pr_contact := nullif(pr ->> 'contact_id', '')::uuid;
    if pr_contact is not null and not (pr_contact = any(readable)) then pr_contact := null; end if;
    insert into public.promises (team_id, visibility, contact_id, project_id, title, direction, due_on,
                                 source, source_ref, evidence, confidence)
    values (p_team_id, vis, coalesce(pr_contact, readable[1]), proj, btrim(pr ->> 'title'),
            case when pr ->> 'direction' = 'made_to_me' then 'made_to_me' else 'made_by_me' end,
            nullif(pr ->> 'due_on', '')::date, 'meeting', m.id::text, pr ->> 'evidence', 'Reviewed by author');
  end loop;

  insert into public.audit_events (team_id, visibility, action, entity, entity_id, detail)
  values (p_team_id, vis, 'filed', 'meeting', m.id,
          jsonb_build_object('contacts', cardinality(readable), 'promises', jsonb_array_length(coalesce(p_promises, '[]'::jsonb))));
  return m.id;
end $$;

revoke execute on function public.finalize_meeting(uuid, text, text, text, uuid[], uuid, uuid, public.visibility, jsonb) from public, anon;
grant execute on function public.finalize_meeting(uuid, text, text, text, uuid[], uuid, uuid, public.visibility, jsonb) to authenticated;

   - Report the result, or the first error line.

2. Deepgram (speech-to-text). Go to https://console.deepgram.com
   - If I don't have an account, STOP and let me sign up myself.
   - Open API Keys and start creating a new key: name it "lumaco", role "Member", no expiration.
   - STOP before the key is shown and tell me to copy it myself. Do not read it.

3. Anthropic (AI notes). Go to https://console.anthropic.com
   - If I'm not signed in or have no account, STOP and let me do it. If it asks for billing details or credits, STOP and let me do it.
   - Go to API Keys → Create Key, name it "lumaco-meeting-notes".
   - STOP before the key is shown and tell me to copy it myself. Do not read it.
   - Suggest I set a monthly spend limit under Limits (for example $20) and let me decide.

4. Store the keys in Supabase. Open https://supabase.com/dashboard/project/czdfwbgfncdqqaxwcicg/functions/secrets
   - Add a secret named DEEPGRAM_API_KEY: type the name, then STOP and ask me to paste the value myself.
   - Add a secret named ANTHROPIC_API_KEY: type the name, then STOP and ask me to paste the value myself.
   - After I say done, save. Confirm both names now appear in the list (values stay hidden).

5. Print exactly this block, filled in:

REPORT BACK — CAPTURE SETUP
Database update: success/failed (<message or first error line>)
Deepgram key created: yes/no (copied by me)
Anthropic key created: yes/no (copied by me), spend limit: <amount or none>
Supabase secrets present: DEEPGRAM_API_KEY yes/no, ANTHROPIC_API_KEY yes/no
Anything that didn't match these instructions: <notes>
````

Then, in a terminal in this repo, sign the Supabase CLI in (it opens your browser; Claude Code can't do this step for you):

```bash
supabase login
```

Tell Claude Code "the CLI is signed in" and it will deploy the `process-meeting` function.

---

## Then, back in Claude Code

Paste all the report blocks plus your **anon / publishable key**, and say "finish the setup". Claude Code will:

1. save the URL and anon key in `app/.env.local` (git-ignored),
2. link the Supabase CLI and apply the database schema (`supabase db push`; you'll sign in to the Supabase CLI once and enter the database password from Part 1 yourself),
3. start the app locally and test sign-up, sign-in, onboarding and teams end to end.

Never paste the **service_role / secret** key, the database password, or the Google/Microsoft client secrets into a chat.
