// Audit trail of automatic changes (sync adding timeline entries and moving contact dates), and undo.
import { requireSupabase, friendlyError } from './supabase';

export type AuditEvent = {
  id: string; owner_id: string; team_id: string | null; action: string; entity_id: string | null; contact_id: string | null;
  source: string | null; created_at: string; undone_at: string | null;
  detail: { kind?: string; direction?: string | null; occurred_at?: string; moved_outreach?: boolean; moved_engagement?: boolean } | null;
  contacts?: { full_name: string } | null;
};
export const AUDIT_SELECT = 'id,owner_id,team_id,action,entity_id,contact_id,source,created_at,undone_at,detail,contacts(full_name)';

export const SOURCE_NAME: Record<string, string> = {
  gmail: 'Gmail', google_calendar: 'Google Calendar', outlook: 'Outlook', microsoft_calendar: 'Outlook calendar', recording: 'a recording', manual: 'you',
};

/** "Email from Sarah Mitchell added from Gmail", plus what it changed. No subjects: callers add those for the author only. */
export function describeEvent(e: AuditEvent): { what: string; changed: string } {
  const who = e.contacts?.full_name ?? 'a contact';
  const d = e.detail ?? {};
  const from = e.source ? SOURCE_NAME[e.source] ?? e.source : 'sync';
  const what = d.kind === 'email' ? `Email ${d.direction === 'outbound' ? 'to' : 'from'} ${who} added from ${from}`
    : d.kind === 'calendar' ? `Meeting with ${who} added from ${from}`
    : `${who}: timeline entry added from ${from}`;
  const changed = [d.moved_outreach && 'last outreach updated', d.moved_engagement && 'last engagement updated'].filter(Boolean).join(', ');
  return { what, changed };
}

/** Undo one automatic change: hides the timeline entry and restores the contact's dates. */
export async function undoChange(id: string): Promise<string | undefined> {
  const { error } = await requireSupabase().rpc('undo_audit_event', { p_event: id });
  return error ? friendlyError(error) : undefined;
}
