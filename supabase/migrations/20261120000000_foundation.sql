-- LuMaCo normal mode: accounts, teams, workspace records, integrations and recordings.
--
-- Privacy model (enforced here with row-level security, not just in the UI):
--   * Every workspace record has an author (owner_id), an optional team (team_id; null = the
--     author's personal workspace) and a visibility:
--       private  -> only the author, even inside a team
--       managers -> the author plus that team's owners/managers
--       team     -> every member of that team
--   * Leaving a team removes access to that team's records immediately.
--   * OAuth tokens live in integration_secrets, which the browser can never read or write.

-- ---------------------------------------------------------------------------------------
-- Types and shared helpers
-- ---------------------------------------------------------------------------------------
create type public.team_role as enum ('owner', 'manager', 'member');
create type public.visibility as enum ('private', 'managers', 'team');

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------------------
-- Profiles (one per auth user, created automatically on sign-up)
-- ---------------------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  full_name    text check (full_name is null or length(full_name) <= 120),
  avatar_url   text,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  );
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------------------
create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger teams_updated_at before update on public.teams
  for each row execute function public.set_updated_at();

create table public.team_members (
  team_id   uuid not null references public.teams (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      public.team_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);

create table public.team_invites (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  email       text not null check (email = lower(btrim(email)) and email like '%@%'),
  role        public.team_role not null default 'member' check (role <> 'owner'),
  invited_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at  timestamptz
);
create unique index team_invites_pending_uniq on public.team_invites (team_id, email)
  where accepted_at is null and revoked_at is null;
create index team_invites_email_idx on public.team_invites (email);

-- Membership helpers. SECURITY DEFINER so policies can call them without recursing into
-- team_members' own policies.
create function public.team_role_of(t uuid) returns public.team_role
language sql stable security definer set search_path = '' as $$
  select role from public.team_members where team_id = t and user_id = auth.uid()
$$;
create function public.is_team_member(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members where team_id = t and user_id = auth.uid())
$$;
create function public.is_team_admin(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.team_role_of(t) in ('owner', 'manager'), false)
$$;

-- The single read rule used by every workspace table.
create function public.can_read(owner uuid, t uuid, v public.visibility) returns boolean
language sql stable security definer set search_path = '' as $$
  select owner = auth.uid()
      or (t is not null and (
            (v = 'team'     and public.is_team_member(t))
         or (v = 'managers' and public.is_team_admin(t))))
$$;
-- Records may only be written into your personal workspace or a team you belong to.
create function public.can_write_scope(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select t is null or public.is_team_member(t)
$$;

-- Create a team and make the caller its owner, atomically.
create function public.create_team(team_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.teams (name, created_by) values (btrim(team_name), auth.uid()) returning id into new_id;
  insert into public.team_members (team_id, user_id, role) values (new_id, auth.uid(), 'owner');
  return new_id;
end $$;

-- Pending invites addressed to the signed-in user's (verified) email, with team names.
create function public.my_invites()
returns table (id uuid, team_id uuid, team_name text, role public.team_role, invited_by_name text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select i.id, i.team_id, t.name, i.role, coalesce(p.full_name, p.email), i.created_at
  from public.team_invites i
  join public.teams t on t.id = i.team_id
  left join public.profiles p on p.id = i.invited_by
  where i.email = lower(auth.jwt() ->> 'email')
    and i.accepted_at is null and i.revoked_at is null
    and not public.is_team_member(i.team_id)
  order by i.created_at desc
$$;

-- Accept an invite sent to the caller's email. Personal records are not moved.
create function public.accept_invite(invite_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare inv public.team_invites;
begin
  select * into inv from public.team_invites
   where id = invite_id and accepted_at is null and revoked_at is null
     and email = lower(auth.jwt() ->> 'email');
  if not found then raise exception 'Invite not found, already used, or sent to a different email'; end if;
  insert into public.team_members (team_id, user_id, role)
    values (inv.team_id, auth.uid(), inv.role) on conflict (team_id, user_id) do nothing;
  update public.team_invites set accepted_at = now() where id = inv.id;
  return inv.team_id;
end $$;

revoke execute on function public.create_team(text), public.my_invites(), public.accept_invite(uuid) from public, anon;
grant execute on function public.create_team(text), public.my_invites(), public.accept_invite(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Workspace records
-- ---------------------------------------------------------------------------------------
create table public.companies (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  team_id    uuid references public.teams (id) on delete cascade,
  visibility public.visibility not null default 'private',
  name       text not null check (length(btrim(name)) between 1 and 160),
  kind       text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id                     uuid primary key default gen_random_uuid(),
  owner_id               uuid not null default auth.uid() references auth.users (id) on delete cascade,
  team_id                uuid references public.teams (id) on delete cascade,
  visibility             public.visibility not null default 'private',
  company_id             uuid references public.companies (id) on delete set null,
  full_name              text not null check (length(btrim(full_name)) between 1 and 160),
  title                  text,
  categories             text[] not null default '{}',
  priority               text not null default 'Medium' check (priority in ('High', 'Medium', 'Low')),
  starred                boolean not null default false,
  detailed               boolean not null default false,
  outreach_cadence_days  int not null default 30 check (outreach_cadence_days between 1 and 365),
  engagement_alert_days  int not null default 90 check (engagement_alert_days between 1 and 365),
  last_outreach_at       timestamptz,
  last_engagement_at     timestamptz,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Verified emails/phone numbers used to match synced messages, calls and texts to a contact.
create table public.contact_identities (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id) on delete cascade,
  kind       text not null check (kind in ('email', 'phone')),
  value      text not null,
  verified   boolean not null default false,
  created_at timestamptz not null default now(),
  unique (contact_id, kind, value)
);
create index contact_identities_lookup_idx on public.contact_identities (kind, value);

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  team_id     uuid references public.teams (id) on delete cascade,
  visibility  public.visibility not null default 'private',
  company_id  uuid references public.companies (id) on delete set null,
  name        text not null check (length(btrim(name)) between 1 and 160),
  description text,
  status      text not null default 'Active',
  progress    int not null default 0 check (progress between 0 and 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.project_contacts (
  project_id uuid not null references public.projects (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  primary key (project_id, contact_id)
);

-- Every observed touchpoint: synced email/calendar, Twilio calls/texts, recordings, manual notes.
create table public.interactions (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  team_id              uuid references public.teams (id) on delete cascade,
  visibility           public.visibility not null default 'private',
  contact_id           uuid references public.contacts (id) on delete cascade,
  project_id           uuid references public.projects (id) on delete set null,
  kind                 text not null check (kind in ('email', 'call', 'text', 'meeting', 'calendar', 'note')),
  direction            text check (direction in ('inbound', 'outbound', 'internal')),
  occurred_at          timestamptz not null,
  title                text,
  summary              text,
  source               text not null,     -- gmail | google_calendar | outlook | microsoft_calendar | twilio | recording | manual
  source_ref           text,              -- provider id, so re-syncs never duplicate
  duration_sec         int,
  qualifies_outreach   boolean not null default false,
  qualifies_engagement boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index interactions_source_uniq on public.interactions (owner_id, source, source_ref) where source_ref is not null;
create index interactions_contact_idx on public.interactions (contact_id, occurred_at desc);

-- Recorded meetings, calls and voice notes. Audio is deleted after transcription by default.
create table public.meetings (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  team_id           uuid references public.teams (id) on delete cascade,
  visibility        public.visibility not null default 'private',
  kind              text not null default 'meeting' check (kind in ('meeting', 'notes', 'call')),
  title             text,
  started_at        timestamptz not null default now(),
  duration_sec      int,
  project_id        uuid references public.projects (id) on delete set null,
  calendar_ref      text,
  consent_confirmed boolean not null default false,
  audio_path        text,
  status            text not null default 'uploaded'
                    check (status in ('recording', 'uploaded', 'transcribing', 'extracting', 'ready', 'reviewed', 'failed')),
  transcript        jsonb,
  transcript_text   text,
  notes             text,
  error             text,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint meetings_consent check (kind <> 'meeting' or consent_confirmed)
);

create table public.meeting_contacts (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  primary key (meeting_id, contact_id)
);

create table public.promises (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  team_id     uuid references public.teams (id) on delete cascade,
  visibility  public.visibility not null default 'private',
  contact_id  uuid references public.contacts (id) on delete cascade,
  project_id  uuid references public.projects (id) on delete set null,
  title       text not null check (length(btrim(title)) between 1 and 300),
  owner_label text not null default 'You',
  direction   text not null default 'made_by_me' check (direction in ('made_by_me', 'made_to_me')),
  due_on      date,
  status      text not null default 'open' check (status in ('open', 'completed', 'dismissed')),
  source      text,
  source_ref  text,
  evidence    text,
  confidence  text,
  completed_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index promises_open_idx on public.promises (owner_id, status, due_on);

create table public.audit_events (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  team_id    uuid references public.teams (id) on delete cascade,
  visibility public.visibility not null default 'private',
  action     text not null,
  entity     text not null,
  entity_id  uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);

-- Same policies for every workspace table.
do $$
declare t text;
begin
  foreach t in array array['companies', 'contacts', 'projects', 'interactions', 'meetings', 'promises', 'audit_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create index %I on public.%I (owner_id)', t || '_owner_idx', t);
    execute format('create index %I on public.%I (team_id) where team_id is not null', t || '_team_idx', t);
    execute format($p$create policy "read by visibility" on public.%I for select to authenticated
                      using (public.can_read(owner_id, team_id, visibility))$p$, t);
    execute format($p$create policy "author inserts" on public.%I for insert to authenticated
                      with check (owner_id = auth.uid() and public.can_write_scope(team_id))$p$, t);
    if t <> 'audit_events' then
      execute format($p$create policy "author updates" on public.%I for update to authenticated
                        using (owner_id = auth.uid())
                        with check (owner_id = auth.uid() and public.can_write_scope(team_id))$p$, t);
      execute format($p$create policy "author deletes" on public.%I for delete to authenticated
                        using (owner_id = auth.uid())$p$, t);
      execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
                     t || '_updated_at', t);
    end if;
  end loop;
end $$;

-- Child tables inherit access from their parent record.
alter table public.contact_identities enable row level security;
create policy "read via contact" on public.contact_identities for select to authenticated using (
  exists (select 1 from public.contacts c where c.id = contact_id and public.can_read(c.owner_id, c.team_id, c.visibility)));
create policy "author writes via contact" on public.contact_identities for all to authenticated
  using (exists (select 1 from public.contacts c where c.id = contact_id and c.owner_id = auth.uid()))
  with check (exists (select 1 from public.contacts c where c.id = contact_id and c.owner_id = auth.uid()));

alter table public.project_contacts enable row level security;
create policy "read via project" on public.project_contacts for select to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and public.can_read(p.owner_id, p.team_id, p.visibility)));
create policy "author writes via project" on public.project_contacts for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

alter table public.meeting_contacts enable row level security;
create policy "read via meeting" on public.meeting_contacts for select to authenticated using (
  exists (select 1 from public.meetings m where m.id = meeting_id and public.can_read(m.owner_id, m.team_id, m.visibility)));
create policy "author writes via meeting" on public.meeting_contacts for all to authenticated
  using (exists (select 1 from public.meetings m where m.id = meeting_id and m.owner_id = auth.uid()))
  with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.owner_id = auth.uid()));

-- ---------------------------------------------------------------------------------------
-- Profiles, teams, membership and invites
-- ---------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
create policy "read self and teammates" on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.team_members mine
    join public.team_members theirs on theirs.team_id = mine.team_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.id));
create policy "update self" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

alter table public.teams enable row level security;
create policy "members read team" on public.teams for select to authenticated using (public.is_team_member(id));
create policy "owners rename team" on public.teams for update to authenticated
  using (public.team_role_of(id) = 'owner') with check (public.team_role_of(id) = 'owner');
create policy "owners delete team" on public.teams for delete to authenticated using (public.team_role_of(id) = 'owner');
-- Teams are created through create_team() so the creator always becomes owner.

alter table public.team_members enable row level security;
create policy "members read roster" on public.team_members for select to authenticated using (public.is_team_member(team_id));
create policy "owners change roles" on public.team_members for update to authenticated
  using (public.team_role_of(team_id) = 'owner' and user_id <> auth.uid())
  with check (public.team_role_of(team_id) = 'owner' and role <> 'owner');
create policy "leave or remove" on public.team_members for delete to authenticated using (
     (user_id = auth.uid() and role <> 'owner')                       -- members/managers can leave
  or (public.team_role_of(team_id) = 'owner' and role <> 'owner')     -- owners remove anyone else
  or (public.team_role_of(team_id) = 'manager' and role = 'member')); -- managers remove members
-- Members join only through accept_invite().

alter table public.team_invites enable row level security;
create policy "admins and invitee read invites" on public.team_invites for select to authenticated
  using (public.is_team_admin(team_id) or email = lower(auth.jwt() ->> 'email'));
create policy "admins invite" on public.team_invites for insert to authenticated
  with check (public.is_team_admin(team_id) and invited_by = auth.uid()
              and (role = 'member' or public.team_role_of(team_id) = 'owner'));
create policy "admins revoke" on public.team_invites for update to authenticated
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------------------------
create table public.integration_connections (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  provider       text not null check (provider in ('google', 'microsoft', 'twilio')),
  status         text not null default 'connected' check (status in ('connected', 'syncing', 'error', 'revoked')),
  account_email  text,
  scopes         text[] not null default '{}',
  connected_at   timestamptz not null default now(),
  last_synced_at timestamptz,
  last_error     text,
  unique (user_id, provider, account_email)
);
alter table public.integration_connections enable row level security;
create policy "users read own connections" on public.integration_connections for select to authenticated
  using (user_id = auth.uid());
create policy "users disconnect own" on public.integration_connections for delete to authenticated
  using (user_id = auth.uid());
-- Inserts/updates come only from Edge Functions using the service role.

-- OAuth tokens and sync cursors. RLS on with no policies: only the service role can touch it.
create table public.integration_secrets (
  connection_id uuid primary key references public.integration_connections (id) on delete cascade,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  sync_cursor   jsonb,
  updated_at    timestamptz not null default now()
);
alter table public.integration_secrets enable row level security;
revoke all on public.integration_secrets from anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- Recording storage: private bucket, one folder per user (<user id>/<meeting id>.webm)
-- ---------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 52428800,
        array['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'])
on conflict (id) do nothing;

create policy "users upload own recordings" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users read own recordings" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "users delete own recordings" on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = auth.uid()::text);
