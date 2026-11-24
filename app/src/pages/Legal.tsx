// Public Privacy Policy and Terms of Service (/privacy, /terms). Google's OAuth verification needs both
// on the app's own domain. Fill in LEGAL before publishing for real users; while any value is still a
// [PLACEHOLDER], each page shows a "draft" notice.
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '../components/Icon';

export const LEGAL = {
  company: 'the LuMaCo team',          // the legal entity that runs LuMaCo
  contact: 'lumaco.support@gmail.com',         // privacy and support address
  jurisdiction: 'Nebraska, United States',  // governing law for the Terms
  effective: 'November 24, 2026',
};
const isDraft = Object.values(LEGAL).some(v => v.startsWith('['));

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} · LuMaCo`; return () => { document.title = 'LuMaCo'; }; }, [title]);
  return (
    <div className="legal">
      <header className="legal-top">
        <Link to="/" aria-label="LuMaCo home" style={{ color: '#fff' }}><BrandMark light /></Link>
        <nav className="legal-nav"><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/signin">Sign in</Link></nav>
      </header>
      <main className="legal-body">
        {isDraft && (
          <div className="alert info" role="note"><strong>Draft.</strong> Items in [brackets] still need to be filled in before LuMaCo is offered to the public.</div>
        )}
        <h1>{title}</h1>
        <p className="muted">Effective {LEGAL.effective}</p>
        {children}
        <p className="muted small" style={{ marginTop: 32 }}>Questions: {LEGAL.contact} · {LEGAL.company}</p>
      </main>
    </div>
  );
}

export function Privacy() {
  return (
    <LegalPage title="Privacy Policy">
      <p>LuMaCo helps contractors and sales teams keep track of customer relationships. To do that it reads information you choose to connect. This policy explains what we collect, why, who else handles it, and the choices you have. LuMaCo is run by {LEGAL.company} (“we”).</p>

      <h2>The short version</h2>
      <ul>
        <li>We only read email and calendars you connect, and only to keep your contacts, follow-ups and promises current.</li>
        <li>We don’t sell your data, show ads, or use your data to train AI models.</li>
        <li>Records you mark private stay private, even from your team’s owner and managers.</li>
        <li>You can download everything or delete your account at any time from the Account page.</li>
      </ul>

      <h2>What we collect</h2>
      <h3>Your account</h3>
      <p>Your name, email address and password (stored only as a secure hash), or your Google or Microsoft sign-in identity if you sign in that way. Signing in with Google or Microsoft does not give us access to your email.</p>
      <h3>What you enter</h3>
      <p>Contacts, companies, projects, promises, notes and your team memberships.</p>
      <h3>Email and calendar you connect</h3>
      <p>When you connect a Google or Microsoft account, LuMaCo reads:</p>
      <ul>
        <li><strong>Calendar:</strong> event titles, times, locations, attendees and video-call links, to record meetings with your contacts. If you allow it, LuMaCo also adds meetings you confirm to your calendar.</li>
        <li><strong>Email:</strong> messages exchanged with the people in your contacts. We store the subject, a short preview, the sender’s name, dates, and a link back to the message, and add entries to that contact’s timeline. We do not store full message bodies.</li>
      </ul>
      <p>To find promises and meetings you arrange by email, the text of new messages with your contacts is sent to our AI provider (Anthropic), which returns suggestions. Nothing becomes a promise or calendar event until you confirm it. Mail from people who aren’t your contacts is not stored or analysed.</p>
      <h3>Meeting recordings and notes</h3>
      <p>Recording requires you to confirm that everyone present has agreed. Audio is uploaded to our storage, transcribed by Deepgram, and the transcript is summarised into draft notes by Anthropic. Audio is deleted after transcription unless you choose to keep it. Transcripts and notes stay in your account until you delete them.</p>
      <h3>Technical data</h3>
      <p>If the app crashes or a server task fails, we log the error message, the page or task, the app version and your browser type, linked to your account. Email addresses and access tokens are removed before saving, and error logs are deleted after 30 days. We don’t use advertising or analytics trackers. Your browser stores your sign-in session locally so you stay signed in.</p>

      <h2>How we use it</h2>
      <p>Only to provide LuMaCo to you and your team: keeping timelines and follow-up dates current, drafting meeting notes, suggesting promises and meetings, showing team views you’re part of, keeping the service secure, and fixing problems. We don’t use your data for advertising, sell it, or use it to train AI models, and our AI providers are not permitted to train on it.</p>

      <h2>Google user data</h2>
      <p>LuMaCo’s use and transfer of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements. Gmail and Google Calendar data is used only to provide the features described above, is not transferred to others except the service providers listed below as needed to provide those features, is never used for advertising, and is not read by people except with your permission, for security, or where the law requires it.</p>

      <h2>Who can see your data</h2>
      <ul>
        <li><strong>Private</strong> records: only you.</li>
        <li><strong>Managers</strong> records: you and your team’s owners and managers.</li>
        <li><strong>Team</strong> records: everyone in that team.</li>
      </ul>
      <p>Team owners and managers can see which <em>kinds</em> of sources each member has connected (for example “Google: email + calendar”), never the account addresses or message content. Email and calendar content is never shared with your team.</p>

      <h2>Service providers</h2>
      <p>These companies process data on our behalf, only to run LuMaCo:</p>
      <ul>
        <li><strong>Supabase</strong>: database, sign-in, file storage and server functions.</li>
        <li><strong>Cloudflare</strong>: hosting the website.</li>
        <li><strong>Anthropic</strong>: AI notes and email suggestions.</li>
        <li><strong>Deepgram</strong>: transcribing recordings.</li>
        <li><strong>Google</strong> and <strong>Microsoft</strong>: only for accounts you connect.</li>
      </ul>
      <p>We may disclose data if the law requires it, or to a successor if LuMaCo is sold or merged, which we would tell you about first.</p>

      <h2>How long we keep it</h2>
      <p>Your data stays until you delete it or your account. Disconnecting an account deletes its tokens and the email and calendar data synced from it. Deleting your account deletes your data, with one exception: contacts, companies, projects, promises and hand-written notes you shared with a team pass to that team’s owner so the team keeps its customer history. Your private records, recordings, meetings and synced email and calendar data are always deleted. Deleted data may remain in our hosting provider’s backups for a limited period before it is overwritten.</p>

      <h2>Your choices and rights</h2>
      <ul>
        <li><strong>Access and download:</strong> Account → Your data → Download my data.</li>
        <li><strong>Correct:</strong> edit any record or your profile in the app.</li>
        <li><strong>Delete:</strong> delete records individually, or your whole account under Account.</li>
        <li><strong>Revoke access:</strong> disconnect accounts in Integrations, or remove LuMaCo in your Google or Microsoft account settings.</li>
      </ul>
      <p>Depending on where you live (for example under the GDPR or US state privacy laws) you may have further rights, including to object to processing or complain to a data protection authority. Contact {LEGAL.contact} and we’ll respond within 30 days.</p>

      <h2>Security</h2>
      <p>Data is encrypted in transit. Email and calendar access tokens are additionally encrypted before storage and can’t be read by the app in your browser. Access rules are enforced in the database itself, not just the app. No system is perfectly secure; we will notify you of a breach affecting your data as the law requires.</p>

      <h2>Children</h2>
      <p>LuMaCo is a business tool and isn’t meant for anyone under 16.</p>

      <h2>Changes</h2>
      <p>If we change this policy in a way that matters, we’ll tell you in the app or by email before it takes effect.</p>
    </LegalPage>
  );
}

export function Terms() {
  return (
    <LegalPage title="Terms of Service">
      <p>These terms are an agreement between you and {LEGAL.company} for your use of LuMaCo. By creating an account or using LuMaCo you agree to them. If you use LuMaCo for a company, you confirm you may agree on its behalf.</p>

      <h2>Your account</h2>
      <p>Keep your sign-in details secure and tell us at {LEGAL.contact} if you think someone else has used your account. You’re responsible for what happens under your account.</p>

      <h2>Your data</h2>
      <p>You keep ownership of everything you put into or connect to LuMaCo. You give us permission to store and process it only to provide the service, as described in the <Link to="/privacy">Privacy Policy</Link>. You can download or delete it at any time.</p>
      <p>Records you share with a team are available to that team. If you delete your account, team-shared contacts, companies, projects, promises and hand-written notes pass to the team’s owner. If you leave a team, you lose access to its records.</p>

      <h2>Recording and consent</h2>
      <p>Many places require the consent of everyone in a conversation before it is recorded. You are responsible for getting that consent and for following the recording, privacy and email laws that apply to you and the people you record or contact. Don’t record anyone who hasn’t agreed.</p>

      <h2>AI-generated content</h2>
      <p>Transcripts, notes, promises and meeting suggestions are produced automatically and can be wrong or incomplete. Review them before relying on them or sharing them with customers. LuMaCo doesn’t act on suggestions until you confirm them.</p>

      <h2>Acceptable use</h2>
      <p>Don’t use LuMaCo to break the law or anyone’s rights; to send spam; to store data you have no right to; to try to access other people’s accounts or data; to probe, overload or disrupt the service; or to copy or resell it.</p>

      <h2>Connected services</h2>
      <p>Google, Microsoft and other services you connect have their own terms. We aren’t responsible for them, and features that depend on them may change if they change.</p>

      <h2>Availability and changes</h2>
      <p>LuMaCo is under active development. Features may change, and the service may occasionally be unavailable. We’ll give reasonable notice before removing a major feature or shutting LuMaCo down, so you can download your data.</p>

      <h2>Fees</h2>
      <p>LuMaCo is currently free. If we introduce paid plans, we’ll tell you the price before you’re charged anything.</p>

      <h2>Ending these terms</h2>
      <p>You can stop at any time by deleting your account. We may suspend or close accounts that break these terms or put the service or other users at risk, and will tell you why unless the law prevents it.</p>

      <h2>Disclaimers and liability</h2>
      <p>LuMaCo is provided “as is”, without warranties of any kind, to the extent the law allows. To the extent the law allows, we aren’t liable for indirect or consequential losses, lost profits or lost data, and our total liability is limited to the greater of the amount you paid us in the 12 months before the claim or US$100. Nothing here limits liability that can’t be limited by law.</p>

      <h2>General</h2>
      <p>These terms are governed by the laws of {LEGAL.jurisdiction}. If part of them can’t be enforced, the rest still applies. We may update them; if a change matters, we’ll tell you before it takes effect, and continuing to use LuMaCo means you accept it.</p>
    </LegalPage>
  );
}
