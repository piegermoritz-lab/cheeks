export const defaultStyle = {
  font: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  weight: 700,
  size: 0.084,          // font size as fraction of video width
  tracking: -0.045,     // letter spacing in em
  lineHeight: 1.1,
  maxWidth: 0.9,        // text block width as fraction of video width
  posY: 0.6,            // vertical centre as fraction of video height
  color: '#ffffff',
  highlight: null,      // colour for the word being spoken, null = off
  stroke: null,
  strokeWidth: 0,       // outline thickness as fraction of font size
  shadow: null,
  lowercase: false,
  uppercase: false,
  stripPunctuation: false,
  pop: false,
  maxWords: 4,
  maxChars: 24,
};

export function groupWords(words, style) {
  const chunks = [];
  let cur = null;
  for (const w of words) {
    const prev = cur?.words.at(-1);
    const chars = cur ? cur.words.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length : 0;
    const brk = !cur
      || cur.words.length >= style.maxWords
      || chars > style.maxChars
      || w.start - prev.end > 0.6
      || /[.!?…]$/.test(prev.text)
      || (/[,;:]$/.test(prev.text) && cur.words.length >= 2);
    if (brk) {
      cur = { words: [] };
      chunks.push(cur);
    }
    cur.words.push({ ...w });
  }
  for (const c of chunks) retime(c);
  closeGaps(chunks);
  return chunks;
}

function retime(c) {
  c.start = c.words[0].start;
  c.end = c.words.at(-1).end;
}

// Hold each caption until the next one starts if the pause is short, so captions don't flicker.
function closeGaps(chunks) {
  chunks.forEach((c, i) => {
    const next = chunks[i + 1];
    if (next && next.start - c.end < 0.5) c.end = next.start;
    else c.end = next ? Math.min(c.end + 0.3, next.start) : c.end + 0.3;
  });
}

export function setChunkText(chunk, text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.length === chunk.words.length) {
    chunk.words.forEach((w, i) => { w.text = tokens[i]; });
    return true;
  }
  const start = chunk.words[0].start;
  const end = chunk.words.at(-1).end;
  const total = tokens.reduce((n, t) => n + t.length, 0);
  let t = start;
  chunk.words = tokens.map(tok => {
    const d = (end - start) * (tok.length / total);
    const w = { text: tok, start: t, end: t + d };
    t += d;
    return w;
  });
  return true;
}

export function flatten(chunks) {
  return chunks.flatMap(c => c.words);
}

export function chunkAt(chunks, t) {
  return chunks.find(c => t >= c.start && t < c.end) ?? null;
}

function display(text, style) {
  let s = text;
  if (style.stripPunctuation) s = s.replace(/[.,;:]+$/g, '').replace(/^["„“«»]+|["„“«»]+$/g, '');
  if (style.lowercase) s = s.toLocaleLowerCase('de');
  if (style.uppercase) s = s.toLocaleUpperCase('de');
  return s;
}

// Canvas letterSpacing isn't available in every Safari version, so fall back to drawing glyph by glyph.
function tracker(ctx, px) {
  const native = 'letterSpacing' in ctx;
  if (native) ctx.letterSpacing = `${px}px`;
  return {
    measure: text => native
      ? ctx.measureText(text).width - px
      : [...text].reduce((w, ch) => w + ctx.measureText(ch).width + px, 0) - px,
    draw(text, x, y, paint) {
      if (native) { paint(text, x, y); return; }
      for (const ch of text) {
        paint(ch, x, y);
        x += ctx.measureText(ch).width + px;
      }
    },
  };
}

export function drawCaption(ctx, W, H, chunks, t, style) {
  const chunk = chunkAt(chunks, t);
  if (!chunk) return;

  const fontPx = Math.round(style.size * W);
  ctx.save();
  ctx.font = `${style.weight} ${fontPx}px ${style.font}`;
  const tr = tracker(ctx, (style.tracking ?? 0) * fontPx);
  const words = chunk.words.map(w => ({ ...w, label: display(w.text, style) })).filter(w => w.label);
  if (!words.length) { ctx.restore(); return; }

  let active = -1;
  if (style.highlight) words.forEach((w, i) => { if (w.start <= t) active = i; });

  const space = ctx.measureText(' ').width;
  const maxW = W * style.maxWidth;
  const lines = [];
  let line = { words: [], width: 0 };
  for (const [i, w] of words.entries()) {
    const ww = tr.measure(w.label);
    const next = line.words.length ? line.width + space + ww : ww;
    if (line.words.length && next > maxW) {
      lines.push(line);
      line = { words: [], width: 0 };
    }
    line.width = line.words.length ? line.width + space + ww : ww;
    line.words.push({ ...w, i, w: ww });
  }
  lines.push(line);

  const lineH = fontPx * style.lineHeight;
  const cy = H * style.posY;
  const scale = style.pop ? Math.min(1, 0.85 + ((t - chunk.start) / 0.09) * 0.15) : 1;

  ctx.translate(W / 2, cy);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -cy);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  let y = cy - ((lines.length - 1) * lineH) / 2;
  for (const ln of lines) {
    let x = (W - ln.width) / 2;
    for (const w of ln.words) {
      if (style.strokeWidth > 0 && style.stroke) {
        if (style.shadow) {
          ctx.shadowColor = style.shadow;
          ctx.shadowBlur = fontPx * 0.15;
          ctx.shadowOffsetY = fontPx * 0.05;
        }
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = fontPx * style.strokeWidth * 2;
        tr.draw(w.label, x, y, (s, px, py) => ctx.strokeText(s, px, py));
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = w.i === active ? style.highlight : style.color;
      tr.draw(w.label, x, y, (s, px, py) => ctx.fillText(s, px, py));
      x += w.w + space;
    }
    y += lineH;
  }
  ctx.restore();
}
