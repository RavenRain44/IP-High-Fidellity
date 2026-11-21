// Microphone recording with MediaRecorder. Opus/WebM on Chrome/Firefox/Android, AAC/MP4 on
// Safari/iPhone. ~32 kbps keeps an hour of speech around 14 MB (storage limit is 50 MB).
export type Recording = { blob: Blob; mime: string; seconds: number };

const CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
export const MAX_BYTES = 50 * 1024 * 1024;

export function recordingSupported(): boolean {
  return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

export class MicRecorder {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;
  private wakeLock: { release: () => Promise<void> } | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = CANDIDATES.find(t => MediaRecorder.isTypeSupported(t));
    this.rec = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    this.chunks = [];
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.startedAt = Date.now(); this.pausedTotal = 0; this.pausedAt = 0;
    // Keep a phone's screen awake while recording (where supported).
    try { this.wakeLock = await (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { /* optional */ }
  }

  get state(): RecordingState | 'idle' { return this.rec?.state ?? 'idle'; }
  get bytes(): number { return this.chunks.reduce((n, c) => n + c.size, 0); }
  get seconds(): number {
    if (!this.startedAt) return 0;
    const paused = this.pausedTotal + (this.pausedAt ? Date.now() - this.pausedAt : 0);
    return Math.max(0, Math.round((Date.now() - this.startedAt - paused) / 1000));
  }

  pause() { if (this.rec?.state === 'recording') { this.rec.pause(); this.pausedAt = Date.now(); } }
  resume() { if (this.rec?.state === 'paused') { this.rec.resume(); this.pausedTotal += Date.now() - this.pausedAt; this.pausedAt = 0; } }

  stop(): Promise<Recording> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec) { reject(new Error('Not recording')); return; }
      const seconds = this.seconds;
      rec.onstop = () => {
        const mime = (rec.mimeType || this.chunks[0]?.type || 'audio/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type: mime });
        this.release();
        resolve({ blob, mime, seconds });
      };
      rec.stop();
    });
  }

  cancel() { try { this.rec?.stop(); } catch { /* already stopped */ } this.release(); this.chunks = []; }

  private release() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.rec = null;
    void this.wakeLock?.release().catch(() => undefined); this.wakeLock = null;
  }
}

export function extensionFor(mime: string): string {
  return mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('mpeg') ? 'mp3' : mime.includes('wav') ? 'wav' : 'webm';
}
