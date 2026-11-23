-- Background sync: connected Google/Microsoft accounts sync about every 30 minutes, even when
-- nobody has LuMaCo open.
--
-- pg_cron runs every 10 minutes and, through pg_net, calls the accounts-sync Edge Function with a
-- shared secret. The function syncs the accounts not synced in the last ~30 minutes.
-- The URL and secret live in Supabase Vault, not here:
--   project_url       https://<project-ref>.supabase.co
--   sync_cron_secret  same value as the Edge Function secret SYNC_CRON_SECRET
-- Without them the timer runs but the request goes nowhere.

-- Contacts a user can see, with their email/phone identities, for server-side sync with nobody signed
-- in. Runs the same read rule (can_read) as a signed-in request by acting as that user for the
-- rest of this one transaction. Server only.
create function public.sync_contacts_for(p_user uuid)
returns table (contact_id uuid, identities jsonb)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if p_user is null then return; end if;
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  return query
    select c.id,
           coalesce((select jsonb_agg(jsonb_build_object('kind', i.kind, 'value', i.value, 'created_at', i.created_at))
                       from public.contact_identities i where i.contact_id = c.id), '[]'::jsonb)
      from public.contacts c
     where public.can_read(c.owner_id, c.team_id, c.visibility)
     limit 5000;
end $$;
revoke all on function public.sync_contacts_for(uuid) from public, anon, authenticated;
grant execute on function public.sync_contacts_for(uuid) to service_role;

-- The timer. Skipped where pg_cron isn't available (for example the local test database).
do $outer$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron/pg_net not available: background sync not scheduled';
    return;
  end if;
  create extension if not exists pg_cron;
  create extension if not exists pg_net with schema extensions;
  if exists (select 1 from cron.job where jobname = 'lumaco-accounts-sync') then
    perform cron.unschedule('lumaco-accounts-sync');
  end if;
  perform cron.schedule('lumaco-accounts-sync', '*/10 * * * *', $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/accounts-sync',
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_cron_secret')),
      body    := '{"scheduled": true}'::jsonb,
      timeout_milliseconds := 150000)
    where exists (select 1 from vault.decrypted_secrets where name = 'sync_cron_secret')
  $job$);
end $outer$;
