-- Phase 6 hardening: data export, account deletion and error logging.
--
--   * export_my_data()            everything the signed-in user owns, as one JSON document (no tokens).
--   * account_deletion_preview()  what deleting the account would do to each team, shown before confirming.
--   * prepare_account_deletion()  run by the account-delete Edge Function just before the auth user is
--                                 deleted: team-shared records pass to the team owner, teams the user
--                                 owned get a new owner (or are deleted if nobody else is in them).
--                                 Everything else cascades away with auth.users.
--   * app_errors / log_client_error()  crash and failure log with personal details scrubbed, kept 30 days.

-- ---------------------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------------------
create function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  out jsonb;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select jsonb_build_object(
    'exported_at', now(),
    'format', 'Lumaco data export v1',
    'profile', (select to_jsonb(p) from public.profiles p where p.id = me),
    'teams', coalesce((select jsonb_agg(jsonb_build_object('team', t.name, 'role', m.role, 'joined_at', m.joined_at))
                       from public.team_members m join public.teams t on t.id = m.team_id where m.user_id = me), '[]'),
    'connected_accounts', coalesce((select jsonb_agg(jsonb_build_object(
                       'provider', c.provider, 'account_email', c.account_email, 'scopes', c.scopes, 'status', c.status,
                       'connected_at', c.connected_at, 'last_synced_at', c.last_synced_at))
                       from public.integration_connections c where c.user_id = me), '[]'),
    'companies',  coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.companies x where x.owner_id = me), '[]'),
    'contacts',   coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object('identities',
                       coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'value', i.value, 'verified', i.verified))
                                 from public.contact_identities i where i.contact_id = x.id), '[]'))
                       order by x.created_at) from public.contacts x where x.owner_id = me), '[]'),
    'projects',   coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object('contact_ids',
                       coalesce((select jsonb_agg(pc.contact_id) from public.project_contacts pc where pc.project_id = x.id), '[]'))
                       order by x.created_at) from public.projects x where x.owner_id = me), '[]'),
    'interactions', coalesce((select jsonb_agg(to_jsonb(x) order by x.occurred_at) from public.interactions x where x.owner_id = me), '[]'),
    'meetings',   coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object('contact_ids',
                       coalesce((select jsonb_agg(mc.contact_id) from public.meeting_contacts mc where mc.meeting_id = x.id), '[]'))
                       order by x.started_at) from public.meetings x where x.owner_id = me), '[]'),
    'promises',   coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.promises x where x.owner_id = me), '[]'),
    'calendar_events', coalesce((select jsonb_agg(to_jsonb(x)) from public.calendar_events x where x.owner_id = me), '[]'),
    'email_threads', coalesce((select jsonb_agg(to_jsonb(x)) from public.email_threads x where x.owner_id = me), '[]'),
    'meeting_suggestions', coalesce((select jsonb_agg(to_jsonb(x)) from public.meeting_suggestions x where x.owner_id = me), '[]'),
    'automatic_changes', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.audit_events x where x.owner_id = me), '[]')
  ) into out;
  return out;
end $$;

-- ---------------------------------------------------------------------------------------
-- Account deletion
-- ---------------------------------------------------------------------------------------
-- Records a deleted account hands to its team: shared (not private) companies, contacts, projects,
-- promises, and hand-written timeline notes. Synced email/calendar entries and meetings never pass on.
create function public.shared_record_count(p_user uuid, p_team uuid) returns int
language sql stable security definer set search_path = '' as $$
  select ((select count(*) from public.companies where owner_id = p_user and team_id = p_team and visibility <> 'private')
        + (select count(*) from public.contacts  where owner_id = p_user and team_id = p_team and visibility <> 'private')
        + (select count(*) from public.projects  where owner_id = p_user and team_id = p_team and visibility <> 'private')
        + (select count(*) from public.promises  where owner_id = p_user and team_id = p_team and visibility <> 'private')
        + (select count(*) from public.interactions where owner_id = p_user and team_id = p_team and visibility <> 'private' and source = 'manual'))::int
$$;
revoke execute on function public.shared_record_count(uuid, uuid) from public, anon, authenticated;

-- Who takes over a team when p_user leaves it: the owner, or if p_user is the owner, the longest-standing
-- manager, else the longest-standing member.
create function public.team_successor(p_user uuid, p_team uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select user_id from public.team_members
   where team_id = p_team and user_id <> p_user
   order by (role = 'owner') desc, (role = 'manager') desc, joined_at, user_id
   limit 1
$$;
revoke execute on function public.team_successor(uuid, uuid) from public, anon, authenticated;

create function public.account_deletion_preview()
returns table (team_id uuid, team_name text, my_role public.team_role, other_members int, successor_name text, shared_records int)
language sql stable security definer set search_path = '' as $$
  select t.id, t.name, m.role,
         (select count(*)::int from public.team_members o where o.team_id = t.id and o.user_id <> auth.uid()),
         (select coalesce(p.full_name, p.email) from public.profiles p where p.id = public.team_successor(auth.uid(), t.id)),
         public.shared_record_count(auth.uid(), t.id)
  from public.team_members m join public.teams t on t.id = m.team_id
  where m.user_id = auth.uid()
  order by t.name
$$;
revoke execute on function public.account_deletion_preview() from public, anon;
grant execute on function public.account_deletion_preview(), public.export_my_data() to authenticated;
revoke execute on function public.export_my_data() from public, anon;

-- Service role only. Returns what happened per team; the caller then deletes the auth user, which
-- cascades every remaining row the user owns.
create function public.prepare_account_deletion(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  m record;
  heir uuid;
  name text;
  n int;
  result jsonb := '[]';
begin
  select coalesce(full_name, email, 'Former member') into name from public.profiles where id = p_user;
  for m in select tm.team_id, tm.role from public.team_members tm where tm.user_id = p_user loop
    heir := public.team_successor(p_user, m.team_id);
    if heir is null then
      -- Nobody else in the team: it goes, with everything in it.
      delete from public.teams where id = m.team_id;
      result := result || jsonb_build_object('team_id', m.team_id, 'deleted_team', true);
      continue;
    end if;
    if m.role = 'owner' then
      update public.team_members set role = 'owner' where team_id = m.team_id and user_id = heir;
    end if;
    heir := (select user_id from public.team_members where team_id = m.team_id and role = 'owner' and user_id <> p_user
              order by joined_at limit 1);
    n := public.shared_record_count(p_user, m.team_id);
    update public.companies set owner_id = heir where owner_id = p_user and team_id = m.team_id and visibility <> 'private';
    update public.contacts  set owner_id = heir where owner_id = p_user and team_id = m.team_id and visibility <> 'private';
    update public.projects  set owner_id = heir where owner_id = p_user and team_id = m.team_id and visibility <> 'private';
    update public.promises  set owner_id = heir, owner_label = case when owner_label = 'You' then name else owner_label end
     where owner_id = p_user and team_id = m.team_id and visibility <> 'private';
    update public.interactions set owner_id = heir
     where owner_id = p_user and team_id = m.team_id and visibility <> 'private' and source = 'manual';
    result := result || jsonb_build_object('team_id', m.team_id, 'new_owner', heir, 'promoted', m.role = 'owner', 'records', n);
  end loop;
  return result;
end $$;
revoke execute on function public.prepare_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.prepare_account_deletion(uuid) to service_role;

-- ---------------------------------------------------------------------------------------
-- Error log
-- ---------------------------------------------------------------------------------------
create table public.app_errors (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id    uuid references auth.users (id) on delete cascade,
  source     text not null check (source in ('web', 'function')),
  location   text,          -- page path (no query string) or function name
  message    text not null,
  stack      text,
  release    text,
  user_agent text
);
create index app_errors_created_idx on public.app_errors (created_at desc);
create index app_errors_user_idx on public.app_errors (user_id, created_at desc) where user_id is not null;
alter table public.app_errors enable row level security;
revoke all on public.app_errors from anon, authenticated;
grant select, insert, delete on public.app_errors to service_role;
-- No policies: only the service role (dashboard, Edge Functions) reads it. Browsers write via log_client_error().

-- Removes email addresses, bearer/JWT tokens and long secrets-looking strings.
create function public.scrub_error_text(t text, max_len int) returns text
language sql immutable set search_path = '' as $$
  select left(
    regexp_replace(
      regexp_replace(
        regexp_replace(coalesce(t, ''), '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]', 'g'),
        'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?', '[token]', 'g'),
      '[A-Za-z0-9_-]{40,}', '[redacted]', 'g'),
    max_len)
$$;

create function public.log_client_error(p_message text, p_stack text default null, p_location text default null,
                                        p_release text default null, p_user_agent text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if coalesce(btrim(p_message), '') = '' then return; end if;
  -- Rate limits: 30 per signed-in user, 200 from all signed-out visitors, per 10 minutes. Extra is dropped.
  if me is not null then
    if (select count(*) from public.app_errors where user_id = me and created_at > now() - interval '10 minutes') >= 30 then return; end if;
  elsif (select count(*) from public.app_errors where user_id is null and source = 'web' and created_at > now() - interval '10 minutes') >= 200 then
    return;
  end if;
  insert into public.app_errors (user_id, source, location, message, stack, release, user_agent)
  values (me, 'web',
          left(split_part(split_part(coalesce(p_location, ''), '?', 1), '#', 1), 200),
          public.scrub_error_text(p_message, 1000),
          nullif(public.scrub_error_text(p_stack, 4000), ''),
          left(p_release, 40), left(p_user_agent, 300));
end $$;
revoke execute on function public.log_client_error(text, text, text, text, text) from public;
grant execute on function public.log_client_error(text, text, text, text, text) to anon, authenticated;

-- Keep errors for 30 days (only where pg_cron is available, as in the hosted project).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('lumaco-error-cleanup', '17 3 * * *', $c$delete from public.app_errors where created_at < now() - interval '30 days'$c$);
  end if;
end $$;
