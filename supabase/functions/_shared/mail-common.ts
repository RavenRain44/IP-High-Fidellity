// Provider-neutral mail helpers shared by the Google and Microsoft integrations.

/** Runs `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ---------------------------------------------------------------------------------------
// Contacts: approved contacts are matched by their saved email addresses
// ---------------------------------------------------------------------------------------
export type ContactIndex = Map<string, string[]>;   // email (lowercase) -> contact ids

export function buildContactIndex(contacts: { id: string; contact_identities?: { kind: string; value: string }[] | null }[]): ContactIndex {
  const idx: ContactIndex = new Map();
  for (const c of contacts) for (const i of c.contact_identities ?? []) {
    if (i.kind !== 'email') continue;
    const e = i.value.trim().toLowerCase();
    if (!e) continue;
    idx.set(e, [...(idx.get(e) ?? []), c.id]);
  }
  return idx;
}

export function matchContacts(emails: string[], idx: ContactIndex): string[] {
  return [...new Set(emails.flatMap(e => idx.get(e.toLowerCase()) ?? []))];
}

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const emailsIn = (header: string | undefined | null) => [...new Set((header ?? '').match(EMAIL_RE)?.map(e => e.toLowerCase()) ?? [])];
export function displayName(from: string | undefined | null): string {
  const s = (from ?? '').trim();
  const m = /^"?([^"<]+?)"?\s*</.exec(s);
  return m ? m[1].trim() : (emailsIn(s)[0] ?? s);
}

export const decodeEntities = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");


/** The new part of an email's text: quoted replies, forwarded blocks and Outlook reply headers removed. */
export function newText(text: string, max = 2500): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const t = line.trim();
    if (/^On .{4,200}wrote:\s*$/.test(t) || /^-{2,}\s*(Original|Forwarded) Message/i.test(t) || /^_{10,}$/.test(t) || (/^From: .+@/.test(t) && lines.length > 2)) break;
    if (line.trimStart().startsWith('>')) continue;
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

export type ParsedMessage = {
  id: string; threadId: string; at: string; direction: 'inbound' | 'outbound';
  from: string; fromName: string; subject: string; snippet: string; contactIds: string[];
  contactEmails: string[];   // the addresses on this message that belong to approved contacts
};

export type ThreadState = { last_message_at: string; message_count: number; dismissed_at: string | null; contact_ids: string[] };

/** Folds newly synced messages into a thread's stored state. */
export function foldThread(existing: ThreadState | null, msgs: ParsedMessage[]) {
  const sorted = [...msgs].sort((a, b) => a.at.localeCompare(b.at));
  const last = sorted[sorted.length - 1];
  const newer = !existing || new Date(last.at).getTime() > new Date(existing.last_message_at).getTime();
  const contacts = [...new Set([...(existing?.contact_ids ?? []), ...msgs.flatMap(m => m.contactIds)])];
  return {
    newer,
    row: {
      contact_ids: contacts,
      message_count: (existing?.message_count ?? 0) + msgs.length,
      ...(newer ? {
        subject: last.subject, snippet: last.snippet, last_message_at: last.at, last_from: last.fromName,
        last_direction: last.direction, needs_reply: last.direction === 'inbound',
        // They wrote again after you dismissed it: bring it back.
        dismissed_at: last.direction === 'inbound' ? null : existing?.dismissed_at ?? null,
      } : {}),
    },
  };
}

