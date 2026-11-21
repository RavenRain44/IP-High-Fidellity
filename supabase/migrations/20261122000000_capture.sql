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
