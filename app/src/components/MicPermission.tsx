import { useState } from 'react';
import { detectPlatform, inAppBrowser, unblockSteps, type MicState } from '../lib/micPermission';
import { Icon } from './Icon';

/** Explains microphone access and helps fix it: ask, granted, blocked (with per-device steps), unsupported. */
export function MicPermission({ state, error, onRequest }: { state: MicState; error: string; onRequest: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const platform = detectPlatform();
  const app = inAppBrowser();
  const ask = async () => { setBusy(true); await onRequest(); setBusy(false); };

  if (state === 'checking') return null;
  if (state === 'granted') return <p className="mic-ok" role="status"><Icon name="check" size="sm" /> Microphone ready</p>;

  if (state === 'unsupported' || app) {
    const copy = async () => { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); } catch { /* ignore */ } };
    return (
      <div className="mic-panel warn" role="alert">
        <strong><Icon name="mic" size="sm" /> {app ? `${app}’s built-in browser can’t use the microphone` : 'This browser can’t record audio'}</strong>
        <p>{app ? `Open this page in your browser (${platform === 'ios' ? 'Safari, Chrome or Firefox' : 'Chrome, Firefox or Samsung Internet'}) instead: tap the ••• or share menu and choose “Open in browser”.`
          : 'Use a current version of Chrome, Safari, Edge or Firefox. You can still type notes below.'}</p>
        <button className="btn sm" onClick={copy}><Icon name="copy" size="sm" /> {copied ? 'Link copied' : 'Copy link'}</button>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="mic-panel warn" role="alert">
        <strong><Icon name="mic" size="sm" /> Microphone access is blocked for this site</strong>
        <p>Your browser remembered “Don’t allow”, so it won’t ask again on its own. To turn it back on:</p>
        <ol>{unblockSteps(platform, window.location.host).map(s => <li key={s}>{s}</li>)}</ol>
        <button className="btn sm primary" onClick={ask} disabled={busy}><Icon name="refresh" size="sm" /> {busy ? 'Checking…' : 'Try again'}</button>
      </div>
    );
  }

  return (
    <div className="mic-panel" role="status">
      <strong><Icon name="mic" size="sm" /> Allow microphone access</strong>
      <p>Your browser will ask whether LuMaCo can use the microphone. Choose <b>Allow</b>. Audio is only recorded when you press Start, and stays private to you.</p>
      {error && <p className="mic-error">{error}</p>}
      <button className="btn sm primary" onClick={ask} disabled={busy}><Icon name="mic" size="sm" /> {busy ? 'Waiting for your answer…' : 'Allow microphone'}</button>
    </div>
  );
}
