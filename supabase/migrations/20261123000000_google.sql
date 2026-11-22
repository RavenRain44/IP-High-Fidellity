-- Phase 3: Google Calendar and Gmail.
--
-- The google-connect Edge Function runs the OAuth flow and stores tokens (encrypted) in
-- integration_secrets; google-sync reads Calendar and Gmail for the user's approved contacts only.
-- Synced calendar events and email threads are personal: only the account owner can see them,
-- even inside a team. Timeline entries created from them are private interactions.

-- One-time OAuth "state" values (CSRF protection for the connect flow). Server-only.
create table public.oauth_states (
  nonce       text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null check (provider in ('google', 'microsoft')),
  return_path text,
  created_at  timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
revoke all on public.oauth_states from anon, authenticated;
grant all on public.oauth_states to service_role;

-- Lets the sync function skip a run when one is already in progress.
alter table public.integration_connections add column sync_started_at timestamptz;

create table public.calendar_events (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  connection_id   uuid not null references public.integration_connections (id) on delete cascade,
  source_ref      text not null,                   -- provider event id
  title           text,
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  all_day         boolean not null default false,
  location        text,
  meeting_url     text,
  html_link       text,
  organizer_email text,
  attendees       jsonb not null default '[]',     -- [{email, name, response}]
  contact_ids     uuid[] not null default '{}',    -- approved contacts among the attendees
  my_response     text,                            -- accepted | declined | tentative | needsAction
  synced_at       timestamptz not null default now(),
  unique (connection_id, source_ref)
);
create index calendar_events_owner_idx on public.calendar_events (owner_id, starts_at);
alter table public.calendar_events enable row level security;
create policy "owners read own events" on public.calendar_events for select to authenticated
  using (owner_id = auth.uid());
grant select on public.calendar_events to authenticated;
grant all on public.calendar_events to service_role;

-- One row per email conversation with an approved contact.
create table public.email_threads (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  connection_id   uuid not null references public.integration_connections (id) on delete cascade,
  thread_id       text not null,
  subject         text,
  snippet         text,
  last_message_at timestamptz not null,
  last_from       text,
  last_direction  text not null check (last_direction in ('inbound', 'outbound')),
  message_count   int not null default 1,
  contact_ids     uuid[] not null default '{}',
  needs_reply     boolean not null default false,  -- the latest message came from the contact
  dismissed_at    timestamptz,                     -- "no reply needed"; cleared when they write again
  web_link        text,
  synced_at       timestamptz not null default now(),
  unique (connection_id, thread_id)
);
create index email_threads_reply_idx on public.email_threads (owner_id, needs_reply, last_message_at desc);
alter table public.email_threads enable row level security;
create policy "owners read own threads" on public.email_threads for select to authenticated
  using (owner_id = auth.uid());
create policy "owners dismiss own threads" on public.email_threads for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select on public.email_threads to authenticated;
grant update (dismissed_at) on public.email_threads to authenticated;
grant all on public.email_threads to service_role;

-- Promises found in email are suggestions until the user keeps them.
alter table public.promises drop constraint promises_status_check;
alter table public.promises add constraint promises_status_check
  check (status in ('suggested', 'open', 'completed', 'dismissed'));
create unique index promises_source_uniq on public.promises (owner_id, source, source_ref, title)
  where source = 'gmail';
