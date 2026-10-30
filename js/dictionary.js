// Edited here in code (not in the app). One entry per line. "wrong = right" replaces whole words/phrases after transcription; a line with just a term is
// sent to Whisper as a spelling hint. Lines starting with # are comments.
export const DEFAULT_DICTIONARY = `# Namen und Orte
Moritz Pieger
Moritz Bieger = Moritz Pieger
Moritz Piger = Moritz Pieger
Moritz Pierger = Moritz Pieger
tri.moritz
VCA Allschwil
VC Allschwil = VCA Allschwil
VCA Alschwil = VCA Allschwil
Vau Ce A Allschwil = VCA Allschwil
Alschwil = Allschwil
Allschwyl = Allschwil
Basel
Münsterplatz
Münster Platz = Münsterplatz
Spiezathlon
Spiez Athlon = Spiezathlon
Spiezatlon = Spiezathlon
Sempachersee
Sempacher See = Sempachersee
Yverdon-les-Bains
Yverdon les Bains = Yverdon-les-Bains
Iverdon = Yverdon
Ironman 70.3
Iron Man = Ironman
70,3 = 70.3
Arda Saatçi
Arda Saatchi = Arda Saatçi
Arda Saatci = Arda Saatçi
Jannis Reichmuth
Janis Reichmuth = Jannis Reichmuth
Jannis Reichmut = Jannis Reichmuth
Janis Reichmut = Jannis Reichmuth
Strava
Instagram

# Triathlon
Triathlon
Triatlon = Triathlon
Tri Athlon = Triathlon
Trisuit
Tri Suit = Trisuit
Try Suit = Trisuit
Sprintdistanz
Mitteldistanz
Altersklasse
Wechselzone
Koppeltraining
Neoprenanzug
Zeitfahrrad
Rennvelo
Velo
Intervalle
Regeneration

# Schweizerdeutsch, das durchrutscht
isch = ist
hüt = heute
hütt = heute
nöd = nicht
nid = nicht
öppis = etwas
gsi = gewesen
chli = ein bisschen
het = hat
hät = hat
guet = gut
zäme = zusammen
nüt = nichts
nüüt = nichts
öpper = jemand
üs = uns
eus = uns
grad = gerade
es bitz = ein bisschen
bitz = bisschen
lueg = schau
gmacht = gemacht
gseh = gesehen
gange = gegangen
gloffe = gelaufen
gschwumme = geschwommen
gfahre = gefahren
`;

const LEAD = /^[„"«‹(]+/;
const TRAIL = /[.,!?;:…»›"“)]+$/;
const norm = t => t.replace(LEAD, '').replace(TRAIL, '').toLocaleLowerCase('de');

export function parseDictionary(text) {
  const terms = [];
  const fixes = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s*(?:=|->|→)\s*/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      fixes.push({ from: parts[0].split(/\s+/).map(norm), to: parts[1].split(/\s+/) });
      // Names on the right-hand side are useful spelling hints too; plain dialect fixes ("isch = ist") are not.
      if (/[A-ZÄÖÜ0-9.]/.test(parts[1])) terms.push(parts[1]);
    } else {
      terms.push(line);
    }
  }
  fixes.sort((a, b) => b.from.length - a.from.length);
  return { terms: [...new Set(terms)], fixes };
}

// Whisper only reads roughly the last 224 tokens of a prompt, so the term list is capped.
export function buildPrompt(base, terms, maxChars = 700) {
  let prompt = base;
  for (const term of terms) {
    const next = `${prompt}${prompt === base ? ' Begriffe: ' : ', '}${term}`;
    if (next.length > maxChars) break;
    prompt = next;
  }
  return prompt === base ? base : `${prompt}.`;
}

// Replaces word sequences, keeping surrounding punctuation, sentence-start capitalisation and the overall timing.
export function applyFixes(words, fixes) {
  const out = [];
  let i = 0;
  while (i < words.length) {
    const hit = fixes.find(f => f.from.every((tok, k) => words[i + k] && norm(words[i + k].text) === tok));
    if (!hit) {
      out.push(words[i]);
      i++;
      continue;
    }
    const seg = words.slice(i, i + hit.from.length);
    const head = seg[0].text.match(LEAD)?.[0] ?? '';
    const tail = seg.at(-1).text.match(TRAIL)?.[0] ?? '';
    const capital = /^[A-ZÄÖÜ]/.test(seg[0].text.replace(LEAD, ''));
    const start = seg[0].start;
    const end = seg.at(-1).end;
    const m = hit.to.length;
    hit.to.forEach((tok, k) => {
      let text = tok;
      if (k === 0 && capital) text = text.charAt(0).toLocaleUpperCase('de') + text.slice(1);
      if (k === 0) text = head + text;
      if (k === m - 1) text += tail;
      out.push({ text, start: start + ((end - start) * k) / m, end: start + ((end - start) * (k + 1)) / m });
    });
    i += hit.from.length;
  }
  return out;
}
