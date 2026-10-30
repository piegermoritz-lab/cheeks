import { parseDictionary, buildPrompt, applyFixes } from './dictionary.js?v=29';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const PROMPT = 'Transkription auf Hochdeutsch. Gesprochen wird Schweizerdeutsch.';

export async function transcribe(audio, apiKey, dictionary = '') {
  const { terms, fixes } = parseDictionary(dictionary);
  const fd = new FormData();
  fd.append('file', audio.blob, audio.name);
  fd.append('model', 'whisper-large-v3');
  fd.append('language', 'de');
  fd.append('temperature', '0');
  fd.append('prompt', buildPrompt(PROMPT, terms));
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
  return removeFillers(applyFixes(toWords(data), fixes));
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

// "eh" is deliberately not a filler: it also means "anyway" ("das mache ich eh").
const FILLER = /^(ä+h+m*|ä+m+|ö+h+m*|ö+m+|e+h+m+|h+m+|m+h+m+)$/i;

export function removeFillers(words) {
  const kept = [];
  let capitalize = false;
  for (const w of words) {
    const bare = w.text.replace(/[.,!?;:…]+$/, '');
    if (!FILLER.test(bare)) {
      if (capitalize) w.text = w.text.charAt(0).toLocaleUpperCase('de') + w.text.slice(1);
      capitalize = false;
      kept.push(w);
      continue;
    }
    // A capitalised filler started a sentence, so the next real word now does.
    if (bare.charAt(0) !== bare.charAt(0).toLocaleLowerCase('de')) capitalize = true;
    // Keep sentence-ending punctuation that was attached to the filler.
    const end = w.text.match(/[.!?…]+$/)?.[0];
    const prev = kept.at(-1);
    if (end && prev && !/[.!?…]$/.test(prev.text)) prev.text = prev.text.replace(/[,;:]+$/, '') + end;
  }
  return kept;
}
