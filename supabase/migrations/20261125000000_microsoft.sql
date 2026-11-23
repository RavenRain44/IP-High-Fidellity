-- Microsoft 365 / Outlook.com alongside Google. Calendar events, email threads and meeting
-- suggestions are already provider-neutral (keyed by connection); this adds what differs.

-- Time zone used to read times in email ("Tuesday at 2"). Google: the calendar's own zone.
-- Microsoft: the user's browser zone, sent with each sync (Graph needs an extra permission for it).
alter table public.integration_connections add column time_zone text;

-- The same promise is never suggested twice from the same Outlook email either.
drop index public.promises_source_uniq;
create unique index promises_source_uniq on public.promises (owner_id, source, source_ref, title)
  where source in ('gmail', 'outlook');
