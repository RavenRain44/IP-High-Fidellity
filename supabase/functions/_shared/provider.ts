// What each email/calendar provider (Google, Microsoft) supplies to the shared sync and calendar code.
import type { ContactIndex, ParsedMessage } from './mail-common.ts';

export type ProviderId = 'google' | 'microsoft';

/** A calendar event in the shape stored in calendar_events (minus owner/connection/sync columns). */
export type NormEvent = {
  source_ref: string; title: string; starts_at: string; ends_at: string | null; all_day: boolean;
  location: string | null; meeting_url: string | null; html_link: string | null; organizer_email: string | null;
  attendees: { email: string; name: string | null; response: string | null }[];
  contact_ids: string[];
  my_response: string | null;   // accepted | declined | tentative | needsAction | null
};

/** An email with an approved contact, plus its new text (for the AI check) and a link to open it. */
export type NormMessage = ParsedMessage & { text: string; link: string | null };

export type NewEvent = {
  title: string; starts_at: string; ends_at: string; time_zone: string; location: string | null;
  description: string; invite: string[];    // empty: nobody is invited or emailed
  source_link: string | null;
};

export type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };

export interface Adapter {
  id: ProviderId;
  name: string;                              // "Google" | "Microsoft"
  mailSource: 'gmail' | 'outlook';
  calendarSource: 'google_calendar' | 'microsoft_calendar';
  canReadMail(scopes: string[]): boolean;
  canReadCalendar(scopes: string[]): boolean;
  canWriteCalendar(scopes: string[]): boolean;
  refresh(refreshToken: string): Promise<TokenResponse>;
  /** The calendar's own IANA time zone, when the provider exposes it. */
  timeZone(token: string): Promise<string | null>;
  events(token: string, from: Date, to: Date, idx: ContactIndex): Promise<NormEvent[]>;
  /**
   * Emails to or from approved contacts. `recent` addresses are searched from `recentAfter`,
   * `backfill` addresses (saved since the last sync) from `backfillAfter`. Messages whose id is in
   * `skip` are not downloaded. At most `cap` messages; `more` says some were left for next time.
   */
  messages(token: string, q: {
    recent: string[]; recentAfter: Date; backfill: string[]; backfillAfter: Date;
    skip: Set<string>; cap: number; account: string; idx: ContactIndex;
  }): Promise<{ messages: NormMessage[]; more: boolean }>;
  createEvent(token: string, ev: NewEvent): Promise<NormEvent | null>;
}

/** An error from a provider's API or sign-in service. */
export class ProviderError extends Error {
  constructor(message: string, public status = 0, public code = '') { super(message); }
}
/** The refresh token was revoked or expired. The user has to connect the account again. */
export const needsReconnect = (e: unknown) =>
  e instanceof ProviderError && (e.code === 'invalid_grant' || e.code === 'interaction_required' || e.status === 401);
