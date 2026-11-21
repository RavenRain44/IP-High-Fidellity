import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { duration } from '../lib/data';
import { extensionFor, MAX_BYTES, MicRecorder, recordingSupported, type Recording } from '../lib/recorder';
import { startProcessing } from '../lib/meetings';
import { Icon } from '../components/Icon';

type Kind = 'meeting' | 'notes';
type Phase = 'ready' | 'recording' | 'paused' | 'recorded' | 'saving';

export function Capture() {
  const sb = requireSupabase();
  const { user } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [kind, setKind] = useState<Kind>(params.get('kind') === 'notes' ? 'notes' : 'meeting');
  const [title, setTitle] = useState('');
  const [consent, setConsent] = useState(false);
  const [typed, setTyped] = useState('');
  const [keepAudio, setKeepAudio] = useState(false);
  const [phase, setPhase] = useState<Phase>('ready');
  const [seconds, setSeconds] = useState(0);
  const [rec, setRec] = useState<Recording | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const recorder = useRef<MicRecorder | null>(null);
  const startedAt = useRef<string>(new Date().toISOString());
  const supported = recordingSupported();
  const preview = useMemo(() => (rec ? URL.createObjectURL(rec.blob) : null), [rec]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  // Tick the timer; warn before leaving mid-recording.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'paused') return;
    const t = setInterval(() => {
      const r = recorder.current; if (!r) return;
      setSeconds(r.seconds);
      if (r.bytes > MAX_BYTES * 0.95) void stop();
    }, 500);
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { clearInterval(t); window.removeEventListener('beforeunload', warn); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  useEffect(() => () => recorder.current?.cancel(), []);

  async function start() {
    setError('');
    if (kind === 'meeting' && !consent) { setError('Confirm that everyone in the meeting agreed to be recorded.'); return; }
    try {
      const r = new MicRecorder(); await r.start();
      recorder.current = r; startedAt.current = new Date().toISOString();
      setRec(null); setSeconds(0); setPhase('recording');
    } catch (e) {
      setError(e instanceof DOMException && e.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.'
        : 'Couldn’t start the microphone. Check that one is connected and not in use by another app.');
    }
  }
  function togglePause() {
    const r = recorder.current; if (!r) return;
    if (phase === 'recording') { r.pause(); setPhase('paused'); } else { r.resume(); setPhase('recording'); }
  }
  async function stop() {
    const r = recorder.current; if (!r) return;
    const result = await r.stop(); recorder.current = null;
    setRec(result); setSeconds(result.seconds); setPhase('recorded');
  }
  function discard() {
    if (rec && !confirm('Discard this recording?')) return;
    recorder.current?.cancel(); recorder.current = null; setRec(null); setSeconds(0); setPhase('ready');
  }

  async function save() {
    setError('');
    if (!rec && !typed.trim()) { setError('Record something or type your notes first.'); return; }
    if (kind === 'meeting' && rec && !consent) { setError('Confirm recording consent before saving.'); return; }
    setPhase('saving');
    const id = crypto.randomUUID();
    let audioPath: string | null = null;
    try {
      if (rec) {
        setStatus('Uploading recording…');
        audioPath = `${user!.id}/${id}.${extensionFor(rec.mime)}`;
        const up = await sb.storage.from('recordings').upload(audioPath, rec.blob, { contentType: rec.mime, upsert: false });
        if (up.error) throw up.error;
      }
      setStatus('Saving…');
      const { error } = await sb.from('meetings').insert({
        id, kind, title: title.trim() || null, started_at: startedAt.current, duration_sec: rec?.seconds ?? null,
        consent_confirmed: kind === 'meeting' ? consent : false, audio_path: audioPath, typed_notes: typed.trim() || null,
        keep_audio: keepAudio, status: 'uploaded',
      });
      if (error) throw error;
      setStatus('Starting transcription…');
      const started = await startProcessing(id);
      nav(`/app/meetings/${id}`, { replace: true, state: started.error ? { processError: started.error } : undefined });
    } catch (e) {
      if (audioPath) void sb.storage.from('recordings').remove([audioPath]);
      setError(friendlyError(e)); setStatus(''); setPhase(rec ? 'recorded' : 'ready');
    }
  }

  const busy = phase === 'saving';
  const live = phase === 'recording' || phase === 'paused';
  return (
    <>
      <div className="page-head"><div><h1>Capture</h1><p>Record a meeting or a voice note. LuMaCo transcribes it and drafts notes, people and promises for you to review.</p></div></div>
      <div className="grid2">
        <section className="card capture">
          <div className="segmented" role="radiogroup" aria-label="What are you capturing?">
            {(['meeting', 'notes'] as Kind[]).map(k => (
              <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} disabled={live || busy || !!rec} onClick={() => setKind(k)}>
                <Icon name={k === 'meeting' ? 'users' : 'edit'} size="sm" /> {k === 'meeting' ? 'Meeting' : 'Voice note'}
              </button>
            ))}
          </div>
          <label className="field"><span>Title (optional)</span><input value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === 'meeting' ? 'e.g. Riverside schedule review' : 'Leave blank to have one written for you'} disabled={busy} /></label>

          {kind === 'meeting' && (
            <label className="consent">
              <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={live || busy} />
              <span><b>Everyone in this meeting agreed to be recorded.</b> Some states require consent from all participants.</span>
            </label>
          )}

          <div className={`recorder ${phase}`}>
            <div className="orb" aria-hidden="true"><Icon name={phase === 'recorded' ? 'check' : 'mic'} size="lg" /></div>
            <div className="timer" aria-live="off">{duration(seconds) || '0s'}</div>
            <p className="small muted" role="status" aria-live="polite">
              {!supported ? 'Recording isn’t supported in this browser. You can still type notes.'
                : phase === 'recording' ? 'Recording… audio stays private to you.' : phase === 'paused' ? 'Paused'
                : phase === 'recorded' ? 'Recording ready. Save it, or record again.' : phase === 'saving' ? status : 'Ready'}
            </p>
            <div className="btn-row center-row">
              {(phase === 'ready' || phase === 'saving') && <button className="btn primary big" onClick={start} disabled={!supported || busy}><Icon name="mic" /> Start recording</button>}
              {live && <>
                <button className="btn" onClick={togglePause}><Icon name={phase === 'paused' ? 'play' : 'pause'} size="sm" /> {phase === 'paused' ? 'Resume' : 'Pause'}</button>
                <button className="btn primary" onClick={() => void stop()}><Icon name="stop" size="sm" /> Stop</button>
                <button className="btn danger" onClick={discard}><Icon name="trash" size="sm" /> Discard</button>
              </>}
              {phase === 'recorded' && <button className="btn" onClick={discard}><Icon name="refresh" size="sm" /> Record again</button>}
            </div>
            {preview && phase === 'recorded' && <audio controls src={preview} className="playback" />}
          </div>

          <label className="field"><span>{kind === 'meeting' ? 'Your notes (optional)' : 'Type notes instead of, or as well as, recording'}</span>
            <textarea rows={4} value={typed} onChange={e => setTyped(e.target.value)} placeholder="Key points, decisions, follow-ups…" disabled={busy} /></label>
          {rec && <label className="check-line"><input type="checkbox" checked={keepAudio} onChange={e => setKeepAudio(e.target.checked)} disabled={busy} /> Keep the audio after transcription (otherwise it’s deleted)</label>}
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="btn-row">
            <button className="btn primary" onClick={save} disabled={busy || live || (!rec && !typed.trim())}>{busy ? status || 'Saving…' : 'Transcribe & draft notes'}</button>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h2><Icon name="sparkle" /> What happens next</h2></div>
          <ol className="steps-list">
            <li><b>Transcribe.</b> Speech becomes text with speaker labels (Deepgram).</li>
            <li><b>Draft.</b> AI writes notes and suggests the people, project and promises it heard (Claude).</li>
            <li><b>Review.</b> You edit anything, choose who can see it, then file it.</li>
            <li><b>File.</b> Notes go to each person’s timeline and the project file; promises go to Open Promises.</li>
          </ol>
          <p className="small muted">Nothing is added to contacts or promises until you approve it. Audio is stored privately and deleted after transcription unless you keep it.</p>
        </section>
      </div>
    </>
  );
}
