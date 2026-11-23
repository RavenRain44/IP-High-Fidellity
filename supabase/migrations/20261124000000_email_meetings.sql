-- Meetings planned in email, waiting for the user to confirm before they go on the calendar,
-- plus a visible result for each sync's AI check (so a failing check can't go unnoticed).

-- e.g. "Checked 5 emails · 1 promise · 0 meetings" or "AI check failed: …". Written by google-sync.
alter table public.integration_connections add column last_check text;

create table public.meeting_suggestions (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  connection_id     uuid not null references public.integration_connections (id) on delete cascade,
  source            text not null default 'gmail',
  source_ref        text not null,                  -- message the meeting was arranged in
  thread_link       text,
  title             text not null check (length(btrim(title)) between 1 and 300),
  starts_at         timestamptz not null,           -- local time resolved with the calendar's time zone
  ends_at           timestamptz,
  time_known        boolean not null default true,  -- false: a day was agreed but no time; the user picks one
  time_zone         text,
  location          text,
  attendee_emails   text[] not null default '{}',   -- the contacts on that email
  contact_ids       uuid[] not null default '{}',
  evidence          text,
  status            text not null default 'suggested' check (status in ('suggested', 'added', 'dismissed')),
  calendar_event_id uuid references public.calendar_events (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (owner_id, source_ref, starts_at)
);
create index meeting_suggestions_open_idx on public.meeting_suggestions (owner_id, status, starts_at);
alter table public.meeting_suggestions enable row level security;
create policy "owners read own meeting suggestions" on public.meeting_suggestions for select to authenticated
  using (owner_id = auth.uid());
create policy "owners decide own meeting suggestions" on public.meeting_suggestions for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
grant select on public.meeting_suggestions to authenticated;
-- Dismissing (or marking added after using the Google Calendar link) is the only browser-side change.
grant update (status) on public.meeting_suggestions to authenticated;
grant all on public.meeting_suggestions to service_role;
