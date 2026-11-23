-- Phase 5: team dashboard, source coverage, audit trail and undo of automatic changes.
--
-- * Automatic changes (sync adding a timeline entry and moving a contact's last outreach /
--   engagement) are logged in audit_events, one event per timeline entry, by the server.
--   The author can undo one: the entry is hidden (undone_at, so later syncs don't add it back)
--   and the contact's dates go back to what they would be without it.
-- * An event is shared with the contact's team only when it moved that shared contact's date,
--   which the team can already see; otherwise it stays private. Event details never hold
--   email subjects or text: the author's own view reads those from the (private) entry.
-- * team_coverage() tells managers which source types each member has connected and how fresh
--   the sync is. Never addresses or content. Members see only their own line.

-- Timeline entries hidden by an undo. Kept (not deleted) so a later sync doesn't add them back.
alter table public.interactions add column undone_at timestamptz;

alter table public.audit_events
  add column contact_id uuid references public.contacts (id) on delete cascade,
  add column source     text,
  add column undone_at  timestamptz;
create index audit_events_owner_recent_idx on public.audit_events (owner_id, created_at desc);
create index audit_events_team_recent_idx on public.audit_events (team_id, created_at desc) where team_id is not null;
create index audit_events_entity_idx on public.audit_events (entity_id);

-- Users can't edit the trail; they undo through undo_audit_event(). (They can still add events
-- about their own records, as finalize_meeting does.)

-- Undo one automatic change. Only the author of the change can undo it.
create function public.undo_audit_event(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ev  public.audit_events%rowtype;
  it  public.interactions%rowtype;
  c   public.contacts%rowtype;
  alt timestamptz;
begin
  select * into ev from public.audit_events where id = p_event and owner_id = auth.uid() for update;
  if not found then raise exception 'Change not found' using errcode = 'P0002'; end if;
  if ev.undone_at is not null then return; end if;
  if ev.action <> 'interaction_added' then raise exception 'This change can''t be undone' using errcode = '22023'; end if;

  update public.interactions set undone_at = now()
   where id = ev.entity_id and owner_id = auth.uid() and undone_at is null
  returning * into it;

  -- Put the contact's dates back: the date from before this change, or a later entry that still stands.
  if it.id is not null and ev.contact_id is not null then
    select * into c from public.contacts where id = ev.contact_id and owner_id = auth.uid() for update;
    if found then
      if coalesce((ev.detail ->> 'moved_outreach')::boolean, false) and c.last_outreach_at = it.occurred_at then
        select max(occurred_at) into alt from public.interactions
         where contact_id = c.id and owner_id = c.owner_id and qualifies_outreach and undone_at is null;
        update public.contacts set last_outreach_at = nullif(greatest(coalesce((ev.detail ->> 'prev_outreach')::timestamptz, '-infinity'), coalesce(alt, '-infinity')), '-infinity')
         where id = c.id;
      end if;
      if coalesce((ev.detail ->> 'moved_engagement')::boolean, false) and c.last_engagement_at = it.occurred_at then
        select max(occurred_at) into alt from public.interactions
         where contact_id = c.id and owner_id = c.owner_id and qualifies_engagement and undone_at is null;
        update public.contacts set last_engagement_at = nullif(greatest(coalesce((ev.detail ->> 'prev_engagement')::timestamptz, '-infinity'), coalesce(alt, '-infinity')), '-infinity')
         where id = c.id;
      end if;
    end if;
  end if;

  update public.audit_events set undone_at = now() where id = ev.id;
end $$;
revoke all on function public.undo_audit_event(uuid) from public, anon;
grant execute on function public.undo_audit_event(uuid) to authenticated;

-- Which sources each team member has connected. Managers/owners see everyone; members see themselves.
create function public.team_coverage(p_team uuid)
returns table (user_id uuid, provider text, mail boolean, calendar boolean, status text, last_synced_at timestamptz, needs_reconnect boolean)
language sql stable security definer set search_path = '' as $$
  select ic.user_id, ic.provider,
         case ic.provider when 'google' then 'https://www.googleapis.com/auth/gmail.readonly' = any(ic.scopes)
                          when 'microsoft' then 'Mail.Read' = any(ic.scopes) else false end,
         case ic.provider when 'google' then exists (select 1 from unnest(ic.scopes) s where s like '%/auth/calendar%')
                          when 'microsoft' then exists (select 1 from unnest(ic.scopes) s where s like 'Calendars.%') else false end,
         case when ic.status = 'syncing' then 'connected' else ic.status end,
         ic.last_synced_at,
         coalesce(ic.last_error ~* 'reconnect', false)
    from public.integration_connections ic
    join public.team_members tm on tm.user_id = ic.user_id and tm.team_id = p_team
   where public.is_team_member(p_team)
     and (public.is_team_admin(p_team) or ic.user_id = auth.uid())
     and ic.status <> 'revoked'
$$;
revoke all on function public.team_coverage(uuid) from public, anon;
grant execute on function public.team_coverage(uuid) to authenticated;
