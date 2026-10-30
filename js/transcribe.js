const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const PROMPT = 'Transkription auf Hochdeutsch. Gesprochen wird Schweizerdeutsch.';

export async function transcribe(wav, apiKey) {
  const fd = new FormData();
  fd.append('file', wav, 'audio.wav');
  fd.append('model', 'whisper-large-v3');
  fd.append('language', 'de');
  fd.append('temperature', '0');
  fd.append('prompt', PROMPT);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ' ' + ((await res.json()).error?.message ?? ''); } catch {}
    throw new Error(`Groq-Fehler: ${msg}`);
  }
  const data = await res.json();
  return toWords(data);
}

// Word timestamps come without punctuation; borrow it from the segment text when the token counts line up.
export function toWords(data) {
  const words = (data.words ?? []).map(w => ({
    text: swiss(w.word.trim()),
    start: w.start,
    end: w.end,
  })).filter(w => w.text);

  for (const seg of data.segments ?? []) {
    const idx = [];
    words.forEach((w, i) => { if (w.start >= seg.start - 0.01 && w.start < seg.end) idx.push(i); });
    const tokens = swiss(seg.text.trim()).split(/\s+/).filter(Boolean);
    if (tokens.length === idx.length) idx.forEach((wi, k) => { words[wi].text = tokens[k]; });
  }
  return words;
}

export function swiss(text) {
  return text.replace(/ß/g, 'ss').replace(/ẞ/g, 'SS');
}
