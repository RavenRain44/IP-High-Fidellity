// Deepgram pre-recorded transcription with speaker labels (diarization).
// Docs: https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded

export type Utterance = { speaker: number; start: number; end: number; text: string };

type DeepgramResponse = {
  results?: {
    utterances?: { speaker?: number; start: number; end: number; transcript: string }[];
    channels?: { alternatives?: { transcript?: string }[] }[];
  };
};

export async function transcribe(audio: Blob, apiKey: string): Promise<Utterance[]> {
  const params = new URLSearchParams({
    model: 'nova-3', smart_format: 'true', punctuate: 'true', diarize: 'true', utterances: 'true', language: 'en',
  });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': audio.type || 'audio/webm' },
    body: audio,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Transcription failed (${res.status}): ${detail}`);
  }
  return parseDeepgram((await res.json()) as DeepgramResponse);
}

export function parseDeepgram(body: DeepgramResponse): Utterance[] {
  const utts = body.results?.utterances ?? [];
  if (utts.length) {
    return utts.filter(u => u.transcript?.trim()).map(u => ({ speaker: u.speaker ?? 0, start: u.start, end: u.end, text: u.transcript.trim() }));
  }
  const text = body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  return text ? [{ speaker: 0, start: 0, end: 0, text }] : [];
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** "[00:12] Speaker 1: ..." lines, merging consecutive turns by the same speaker. */
export function formatTranscript(utts: Utterance[], names: Record<string, string | null> = {}): string {
  const lines: string[] = [];
  let last = -1;
  for (const u of utts) {
    const label = `Speaker ${u.speaker + 1}`;
    const who = names[label] || label;
    if (u.speaker === last && lines.length) lines[lines.length - 1] += ' ' + u.text;
    else lines.push(`[${clock(u.start)}] ${who}: ${u.text}`);
    last = u.speaker;
  }
  return lines.join('\n');
}
