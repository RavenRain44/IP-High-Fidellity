import { useCallback, useEffect, useState } from 'react';
import { recordingSupported } from './recorder';

export type MicState = 'checking' | 'prompt' | 'granted' | 'denied' | 'unsupported';
export type Platform = 'ios' | 'android' | 'mac' | 'desktop';

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support tells them apart.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh/.test(ua)) return 'mac';
  return 'desktop';
}

/** In-app browsers (Snapchat, Instagram, Facebook, TikTok…) often can't use the microphone at all. */
export function inAppBrowser(): string | null {
  const ua = navigator.userAgent;
  const m = /(Snapchat|Instagram|FBAN|FBAV|FB_IAB|TikTok|musical_ly|LinkedInApp|Line\/|Twitter)/.exec(ua);
  if (!m) return null;
  return { FBAN: 'Facebook', FBAV: 'Facebook', FB_IAB: 'Facebook', musical_ly: 'TikTok', 'Line/': 'LINE', LinkedInApp: 'LinkedIn' }[m[1]] ?? m[1];
}

/**
 * Tracks microphone permission and can ask for it. Uses the Permissions API where the browser
 * has it (Chrome, Edge, Firefox, Safari 16+) and falls back to "prompt" elsewhere.
 */
export function useMicPermission() {
  const [state, setState] = useState<MicState>(() => (recordingSupported() ? 'checking' : 'unsupported'));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!recordingSupported()) return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const update = () => { if (!cancelled && status) setState(status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'prompt'); };
    navigator.permissions?.query({ name: 'microphone' as PermissionName })
      .then(s => { status = s; update(); s.addEventListener('change', update); })
      .catch(() => { if (!cancelled) setState('prompt'); });
    if (!navigator.permissions) setState('prompt');
    return () => { cancelled = true; status?.removeEventListener('change', update); };
  }, []);

  /** Shows the browser's microphone prompt. Opens and immediately releases the mic. */
  const request = useCallback(async (): Promise<boolean> => {
    setError('');
    if (!recordingSupported()) { setState('unsupported'); return false; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      setState('granted');
      return true;
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') setState('denied');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setError('No microphone was found. Connect one, or check it isn’t disabled.');
      else if (name === 'NotReadableError') setError('The microphone is busy in another app (a call or another recorder). Close it and try again.');
      else setError('Couldn’t reach the microphone. Try again.');
      return false;
    }
  }, []);

  return { state, error, request };
}

/** How to turn the microphone back on after it was blocked, per platform. */
export function unblockSteps(platform: Platform, host: string): string[] {
  switch (platform) {
    case 'ios': return [
      `In Safari, tap the “aA” (or page menu) button in the address bar → Website Settings → Microphone → Allow.`,
      `If that isn’t there: open the Settings app → Apps → Safari → Microphone → set to Ask or Allow.`,
      'Using Chrome on iPhone? Settings app → Apps → Chrome → turn Microphone on.',
      'Come back here and tap “Try again”.',
    ];
    case 'android': return [
      'Tap the icon to the left of the address bar → Permissions (or Site settings) → Microphone → Allow.',
      'If Chrome itself has no microphone access: Settings app → Apps → Chrome → Permissions → Microphone → Allow.',
      'Come back here and tap “Try again”.',
    ];
    case 'mac': return [
      `Click the icon to the left of ${host} in the address bar → Microphone → Allow.`,
      'If the browser itself is blocked: System Settings → Privacy & Security → Microphone → turn on your browser, then restart it.',
      'Reload this page and tap “Try again”.',
    ];
    default: return [
      `Click the icon to the left of ${host} in the address bar → Site settings → Microphone → Allow.`,
      'On Windows, also check Settings → Privacy & security → Microphone → “Let desktop apps access your microphone”.',
      'Reload this page and tap “Try again”.',
    ];
  }
}
