export const defaultStyle = {
  font: 'Montserrat',
  weight: 900,
  size: 0.075,          // font size as fraction of video width
  lineHeight: 1.15,
  maxWidth: 0.86,       // text block width as fraction of video width
  posY: 0.68,           // vertical centre as fraction of video height
  color: '#ffffff',
  highlight: '#ffe600',
  stroke: '#000000',
  strokeWidth: 0.12,    // outline thickness as fraction of font size
  shadow: 'rgba(0,0,0,0.55)',
  uppercase: false,
  stripPunctuation: true,
  pop: true,
  maxWords: 3,
  maxChars: 22,
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
  if (style.uppercase) s = s.toUpperCase();
  return s;
}

export function drawCaption(ctx, W, H, chunks, t, style) {
  const chunk = chunkAt(chunks, t);
  if (!chunk) return;

  const fontPx = Math.round(style.size * W);
  ctx.font = `${style.weight} ${fontPx}px "${style.font}", sans-serif`;
  const words = chunk.words.map(w => ({ ...w, label: display(w.text, style) })).filter(w => w.label);
  if (!words.length) return;

  let active = -1;
  words.forEach((w, i) => { if (w.start <= t) active = i; });

  const space = ctx.measureText(' ').width;
  const maxW = W * style.maxWidth;
  const lines = [];
  let line = { words: [], width: 0 };
  for (const [i, w] of words.entries()) {
    const ww = ctx.measureText(w.label).width;
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

  ctx.save();
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
      if (style.strokeWidth > 0) {
        if (style.shadow) {
          ctx.shadowColor = style.shadow;
          ctx.shadowBlur = fontPx * 0.15;
          ctx.shadowOffsetY = fontPx * 0.05;
        }
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = fontPx * style.strokeWidth * 2;
        ctx.strokeText(w.label, x, y);
        ctx.shadowColor = 'transparent';
      }
      ctx.fillStyle = w.i === active ? style.highlight : style.color;
      ctx.fillText(w.label, x, y);
      x += w.w + space;
    }
    y += lineH;
  }
  ctx.restore();
}
