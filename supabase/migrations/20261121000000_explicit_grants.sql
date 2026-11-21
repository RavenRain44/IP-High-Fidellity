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
