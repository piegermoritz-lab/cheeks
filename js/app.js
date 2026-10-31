import { extractAudio } from './audio.js?v=30';
import { transcribe } from './transcribe.js?v=30';
import { DEFAULT_DICTIONARY } from './dictionary.js?v=30';
import {
  defaultStyle, groupWords, setChunkText, flatten, chunkAt, drawCaption, splitChunk, mergeWithNext, moveEdge,
} from './captions.js?v=30';
import { renderVideo } from './render.js?v=30';
import { renderFast } from './render-fast.js?v=30';

const $ = id => document.getElementById(id);

const store = {
  get(k, fallback) { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  screen: 'start',
  returnTo: 'start',
  url: null,
  chunks: [],
  selected: -1,
  style: {
    ...defaultStyle,
    maxWords: Number(store.get('maxWords', defaultStyle.maxWords)),
    posY: Number(store.get('posY', defaultStyle.posY)),
    size: Number(store.get('size', defaultStyle.size)),
  },
  result: null,
  rendering: false,
};

let audioCtx = null;
const preview = $('preview');
const overlay = $('overlay');
const stage = $('stage');

function show(name) {
  state.screen = name;
  for (const s of ['start', 'busy', 'editor', 'settings']) $(`screen-${s}`).hidden = s !== name;
  document.body.classList.toggle('editing', name === 'editor');
  $('btn-back').hidden = name === 'start' || (name === 'busy' && !state.result);
  $('btn-settings').hidden = name === 'settings' || name === 'busy';
  $('btn-theme').hidden = name === 'editor';
  $('btn-export').hidden = name !== 'editor';
  if (name !== 'editor') preview.pause();
  $('key-hint').hidden = !!store.get('groqKey', '');
}

function setBusy(text, progress = null, hint = '') {
  $('busy-text').textContent = text;
  $('busy-hint').textContent = hint;
  $('busy-bar').parentElement.hidden = progress === null;
  $('busy-bar').style.width = `${Math.round((progress ?? 0) * 100)}%`;
  $('btn-save').hidden = true;
  document.querySelector('.spinner').hidden = false;
  $('done-check').hidden = true;
}

/* ---------- Start ---------- */

$('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const key = store.get('groqKey', '');
  if (!key) { openSettings(); return; }

  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(file);
  state.file = file;
  state.result = null;
  show('busy');
  try {
    setBusy('Audio wird gelesen…');
    const audio = await extractAudio(file);
    setBusy('Transkribiere…', null, 'Schweizerdeutsch → Hochdeutsch');
    const words = await transcribe(audio, key, DEFAULT_DICTIONARY);
    if (!words.length) throw new Error('Keine Sprache erkannt.');
    state.chunks = groupWords(words, state.style);
    state.selected = -1;
    history.length = 0;
    updateUndo();
    openEditor();
  } catch (err) {
    alert(err.message || String(err));
    show('start');
  }
});

/* ---------- Editor ---------- */

const PPS = 60; // timeline pixels per second
const timeline = $('timeline');
const track = $('tl-track');
const capsEl = $('tl-captions');
const thumbs = $('tl-thumbs');
const editText = $('edit-text');

let playhead = 0;
let handleDrag = null;

const fmtPrecise = t => `${Math.floor(t / 60)}:${(Math.max(0, t) % 60).toFixed(1).padStart(4, '0')}`;
const duration = () => (preview.duration > 0 && Number.isFinite(preview.duration) ? preview.duration : state.media?.duration ?? 0);
const videoSize = () => ({
  W: state.media?.width || preview.videoWidth || 9,
  H: state.media?.height || preview.videoHeight || 16,
});

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function openEditor() {
  if (preview.src !== state.url) {
    preview.src = state.url;
    preview.load();
    state.media = null;
    timelineFor = null;
    frameCanvas.hidden = true;
    probeMedia(state.file, state.url);
  }
  playhead = 0;
  closePanels();
  show('editor');
  layoutStage();
  if (duration()) buildTimeline();
}

// iOS doesn't load a <video> before the first tap on play, so duration, size and still frames are read from the
// file directly. The <video> element is then only needed for playback.
async function probeMedia(file, url) {
  try {
    const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) return;
    const media = {
      duration: await input.computeDuration(),
      width: vt.displayWidth,
      height: vt.displayHeight,
      first: await vt.getFirstTimestamp(),
      sink: (await vt.canDecode()) ? new mb.CanvasSink(vt) : null,
    };
    if (state.url !== url) return;
    state.media = media;
    layoutStage();
    buildTimeline();
  } catch (err) {
    console.warn('Reading the video file failed', err);
  }
}

preview.addEventListener('loadedmetadata', () => {
  layoutStage();
  buildTimeline();
});

/* Still frames: while paused, the frame under the playhead is decoded from the file and drawn over the <video>. */

const frameCanvas = $('frame');
let frameWanted = null;
let frameBusy = false;
let frameShown = -1;

async function requestFrame(t) {
  if (!state.media?.sink) return;
  frameWanted = t;
  if (frameBusy) return;
  frameBusy = true;
  try {
    while (frameWanted !== null) {
      const want = frameWanted;
      frameWanted = null;
      const wrapped = await state.media.sink.getCanvas(Math.max(want, state.media.first));
      frameShown = want;
      if (!wrapped || !preview.paused || frameWanted !== null) continue;
      const ctx = frameCanvas.getContext('2d');
      ctx.drawImage(wrapped.canvas, 0, 0, frameCanvas.width, frameCanvas.height);
      frameCanvas.hidden = false;
    }
  } catch (err) {
    console.warn('Decoding a still frame failed', err);
    frameShown = playhead;
  } finally {
    frameBusy = false;
  }
}

preview.addEventListener('play', () => { frameCanvas.hidden = true; frameShown = -1; });

// iOS shows a black box until a video has played once, so play it muted for an instant and stop on the first frame.
preview.addEventListener('loadeddata', async () => {
  if (preview.played.length) return;
  preview.muted = true;
  try {
    await preview.play();
    preview.pause();
  } catch {}
  preview.muted = false;
  preview.currentTime = playhead;
});

// Fit the preview into whatever space is left above the timeline.
function layoutStage() {
  const wrap = $('stage-wrap');
  const { W, H } = videoSize();
  const w = Math.min(wrap.clientWidth, wrap.clientHeight * (W / H));
  stage.style.width = `${Math.floor(w)}px`;
  stage.style.height = `${Math.floor(w * (H / W))}px`;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(w * dpr);
  const ch = Math.round(w * (H / W) * dpr);
  if (overlay.width !== cw || overlay.height !== ch) {
    overlay.width = frameCanvas.width = cw;
    overlay.height = frameCanvas.height = ch;
    frameShown = -1;
  }
}
new ResizeObserver(() => { if (state.screen === 'editor') layoutStage(); }).observe($('stage-wrap'));

let timelineFor = null;
function buildTimeline() {
  const key = `${state.url}|${duration()}`;
  if (!duration() || timelineFor === key) return;
  timelineFor = key;
  track.style.width = `${Math.ceil(duration() * PPS)}px`;
  renderBlocks();
  scrollToTime(playhead);
  buildThumbs();
}

// Thumbnails come straight from the file via WebCodecs (works on iOS, where drawing a hidden <video> stays blank).
// A hidden <video> is the fallback; if neither yields frames the strip is hidden and only captions remain.
let thumbJob = 0;
async function buildThumbs() {
  const job = ++thumbJob;
  const dur = duration();
  const { W, H } = videoSize();
  if (!dur) return;
  const dpr = window.devicePixelRatio || 1;
  const trackW = Math.ceil(dur * PPS);
  const tileH = 44;
  const tileW = tileH * (W / H);
  const scale = Math.min(dpr, 16000 / trackW);
  thumbs.width = Math.round(trackW * scale);
  thumbs.height = Math.round(tileH * dpr);
  thumbs.style.width = `${trackW}px`;
  track.classList.remove('no-thumbs');
  const ctx = thumbs.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, thumbs.width, thumbs.height);

  const tiles = Math.ceil(trackW / tileW);
  const count = Math.min(tiles, 30);
  const times = Array.from({ length: count }, (_, f) => Math.min(dur - 0.05, ((f + 0.5) / count) * dur));
  let drawn = 0;
  const paint = (img, f) => {
    if (job !== thumbJob) return false;
    for (let k = 0; k < tiles; k++) {
      if (Math.min(count - 1, Math.floor((k / tiles) * count)) === f) {
        ctx.drawImage(img, k * tileW * scale, 0, tileW * scale, thumbs.height);
      }
    }
    if (drawn++ === 0 && looksBlank(ctx, tileW * scale)) throw new Error('blank frame');
    return true;
  };

  for (const source of [framesFromFile, framesFromVideo]) {
    try {
      drawn = 0;
      await source(times, Math.round(tileW * dpr), Math.round(tileH * dpr), paint);
      if (drawn > 0 || job !== thumbJob) return;
    } catch (err) {
      console.warn('Thumbnail source failed', err);
      ctx.clearRect(0, 0, thumbs.width, thumbs.height);
    }
  }
  if (job === thumbJob) track.classList.add('no-thumbs');
}

// Samples a few pixels of the first tile; a blank or single-colour result means the source gave no real frame.
function looksBlank(ctx, tileWidth) {
  const px = [[0.2, 0.3], [0.5, 0.5], [0.8, 0.7]].map(([x, y]) =>
    [...ctx.getImageData(Math.floor(tileWidth * x), Math.floor(ctx.canvas.height * y), 1, 1).data]);
  return px.every(p => p[3] === 0) || px.every(p => p.join() === px[0].join());
}

async function framesFromFile(times, w, h, paint) {
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(state.file), formats: mb.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt || !(await vt.canDecode())) throw new Error('cannot decode');
  const sink = new mb.CanvasSink(vt, { width: w, height: h, fit: 'cover' });
  let f = 0;
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    if (wrapped && !paint(wrapped.canvas, f)) return;
    f++;
  }
}

async function framesFromVideo(times, w, h, paint) {
  const v = el('video', { muted: true, playsInline: true, preload: 'auto', src: state.url });
  v.muted = true;
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  document.body.append(v);
  try {
    await new Promise((resolve, reject) => {
      v.addEventListener('loadeddata', resolve, { once: true });
      v.addEventListener('error', reject, { once: true });
    });
    // iOS only paints frames of a video that has played at least once.
    await v.play().catch(() => {});
    v.pause();
    for (const [f, t] of times.entries()) {
      await new Promise(r => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; });
      if (!paint(v, f)) return;
    }
  } finally {
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

function renderBlocks() {
  capsEl.replaceChildren(...state.chunks.map((c, i) => {
    const block = el('div', { className: 'cap' }, el('span', { textContent: c.words.map(w => w.text).join(' ') }));
    block.style.left = `${c.start * PPS}px`;
    block.style.width = `${Math.max(4, (c.end - c.start) * PPS)}px`;
    block.dataset.i = i;
    if (i === state.selected) {
      block.classList.add('selected');
      for (const edge of ['start', 'end']) {
        const h = el('div', { className: `handle ${edge === 'start' ? 'l' : 'r'}` });
        h.addEventListener('pointerdown', e => startHandleDrag(e, i, edge));
        block.append(h);
      }
    }
    block.addEventListener('click', e => {
      e.stopPropagation();
      if (!e.target.closest('.handle')) selectChunk(i);
    });
    return block;
  }));
  activeIndex = -2;
}

// Cheap update while dragging: replacing the DOM would drop the pointer capture on the handle.
function positionBlocks() {
  for (const b of capsEl.children) {
    const c = state.chunks[Number(b.dataset.i)];
    b.style.left = `${c.start * PPS}px`;
    b.style.width = `${Math.max(4, (c.end - c.start) * PPS)}px`;
  }
}

function selectChunk(i) {
  state.selected = i;
  const c = state.chunks[i];
  $('style-panel').hidden = true;
  $('btn-style').classList.remove('on');
  $('edit-panel').hidden = false;
  editText.value = c.words.map(w => w.text).join(' ');
  caretPos = null;
  updatePanelButtons();
  renderBlocks();
  if (playhead < c.start || playhead >= c.end) seek(c.start + 0.01);
}

function updatePanelButtons() {
  const c = state.chunks[state.selected];
  $('btn-split').disabled = !c || c.words.length < 2;
  $('btn-merge').disabled = state.selected < 0 || state.selected >= state.chunks.length - 1;
}

function closePanels() {
  state.selected = -1;
  $('edit-panel').hidden = true;
  $('style-panel').hidden = true;
  $('btn-style').classList.remove('on');
  editText.blur();
  renderBlocks();
}

timeline.addEventListener('click', e => {
  if (!e.target.closest('.cap')) closePanels();
});

/* Playhead: while playing the timeline follows the video; when the user scrolls, the video follows the timeline. */

let lastScroll = -10;
function scrollToTime(t) {
  const x = Math.round(t * PPS);
  if (Math.abs(timeline.scrollLeft - x) < 1) return;
  lastScroll = x;
  timeline.scrollLeft = x;
}

let pendingSeek = null;
function scrubTo(t) {
  if (preview.seeking) { pendingSeek = t; return; }
  preview.currentTime = t;
}
preview.addEventListener('seeked', () => {
  if (pendingSeek === null) return;
  const t = pendingSeek;
  pendingSeek = null;
  preview.currentTime = t;
});

timeline.addEventListener('scroll', () => {
  if (Math.abs(timeline.scrollLeft - lastScroll) <= 1 || handleDrag) return;
  lastScroll = -10;
  if (!preview.paused) preview.pause();
  playhead = Math.min(duration(), Math.max(0, timeline.scrollLeft / PPS));
  scrubTo(playhead);
});

function seek(t, scroll = true) {
  preview.pause();
  playhead = Math.min(duration() || t, Math.max(0, t));
  scrubTo(playhead);
  if (scroll) scrollToTime(playhead);
}

function togglePlay() {
  if (!preview.paused) { preview.pause(); return; }
  if (playhead >= duration() - 0.05) seek(0);
  preview.currentTime = playhead;
  preview.play();
}
$('btn-play').addEventListener('click', togglePlay);

/* Handles: drag the edges of the selected caption to change when it starts and ends. */

function startHandleDrag(e, i, edge) {
  e.preventDefault();
  e.stopPropagation();
  preview.pause();
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  const base = JSON.stringify(state.chunks);
  snapshot();
  handleDrag = { i, edge, x: e.clientX, base };

  const move = ev => {
    const chunks = JSON.parse(base);
    moveEdge(chunks, i, edge, (ev.clientX - handleDrag.x) / PPS, duration() || Infinity);
    state.chunks = chunks;
    const c = chunks[i];
    playhead = edge === 'start' ? c.start + 0.01 : Math.max(c.start, c.end - 0.05);
    scrubTo(playhead);
    positionBlocks();
  };
  const up = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    if (JSON.stringify(state.chunks) === base) { history.pop(); updateUndo(); }
    handleDrag = null;
    playhead = timeline.scrollLeft / PPS;
    scrubTo(playhead);
    renderBlocks();
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

/* Edit panel */

let caretPos = null;
const rememberCaret = () => { caretPos = editText.selectionStart; };
for (const ev of ['keyup', 'pointerup', 'select']) editText.addEventListener(ev, rememberCaret);
editText.addEventListener('input', () => {
  const c = state.chunks[state.selected];
  if (!c) return;
  beginChange('text');
  if (setChunkText(c, editText.value)) renderBlocks();
  updatePanelButtons();
  rememberCaret();
});
editText.addEventListener('blur', () => endChange('text'));
editText.addEventListener('keydown', e => { if (e.key === 'Enter') editText.blur(); });

function edit(fn) {
  const before = JSON.stringify(state.chunks);
  snapshot();
  fn();
  if (JSON.stringify(state.chunks) === before) { history.pop(); updateUndo(); }
}

$('btn-split').addEventListener('click', () => {
  const i = state.selected;
  const c = state.chunks[i];
  if (!c) return;
  let n;
  const text = editText.value;
  if (caretPos !== null && caretPos > 0 && caretPos < text.trimEnd().length) {
    n = text.slice(0, caretPos).trim().split(/\s+/).filter(Boolean).length;
  } else {
    const before = c.words.filter(w => w.start < playhead).length;
    n = before > 0 && before < c.words.length ? before : Math.ceil(c.words.length / 2);
  }
  edit(() => splitChunk(state.chunks, i, n));
  selectChunk(i);
});

$('btn-merge').addEventListener('click', () => {
  const i = state.selected;
  edit(() => mergeWithNext(state.chunks, i));
  selectChunk(i);
});

$('btn-delete').addEventListener('click', () => {
  const i = state.selected;
  if (i < 0) return;
  edit(() => state.chunks.splice(i, 1));
  closePanels();
});

$('btn-done').addEventListener('click', closePanels);

$('btn-style').addEventListener('click', () => {
  const open = $('style-panel').hidden;
  closePanels();
  $('style-panel').hidden = !open;
  $('btn-style').classList.toggle('on', open);
});

/* Caption style: height and size */

// While adjusting, show a sample caption even if none is on screen at the current time.
let adjustUntil = 0;

function setStyle(key, value) {
  state.style[key] = value;
  store.set(key, value);
  adjustUntil = performance.now() + 1200;
}

// WebKit has no native "filled" part for range inputs, so the track gradient reads the fill from --p.
function setSlider(input, value) {
  input.value = value;
  input.style.setProperty('--p', `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
}

for (const [id, key] of [['pos-y', 'posY'], ['size', 'size']]) {
  const input = $(id);
  setSlider(input, state.style[key]);
  input.addEventListener('input', () => {
    beginChange('slider');
    setSlider(input, input.value);
    setStyle(key, Number(input.value));
  });
  input.addEventListener('change', () => endChange('slider'));
}

// One finger drags the caption up/down, two fingers pinch to resize it, a tap without movement plays/pauses.
const pointers = new Map();
let drag = null;
let pinch = null;
let gestureMoved = false;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fingerGap = () => {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), midY: (a.y + b.y) / 2 };
};

stage.addEventListener('pointerdown', e => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    gestureMoved = false;
    drag = { y: e.clientY, pos: state.style.posY };
  } else if (pointers.size === 2) {
    drag = null;
    gestureMoved = true;
    const { dist, midY } = fingerGap();
    pinch = { dist: Math.max(10, dist), midY, size: state.style.size, pos: state.style.posY };
    beginChange('pinch');
  }
});

stage.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const { dist, midY } = fingerGap();
    const size = clamp(pinch.size * (dist / pinch.dist), 0.03, 0.2);
    const pos = clamp(pinch.pos + (midY - pinch.midY) / stage.clientHeight, 0.08, 0.95);
    setStyle('size', size);
    setStyle('posY', pos);
    setSlider($('size'), size);
    setSlider($('pos-y'), pos);
    return;
  }
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (!gestureMoved && Math.abs(dy) < 6) return;
  if (!gestureMoved) beginChange('drag');
  gestureMoved = true;
  const pos = clamp(drag.pos + dy / stage.clientHeight, 0.08, 0.95);
  setStyle('posY', pos);
  setSlider($('pos-y'), pos);
});

function releasePointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size > 0) {
    // Lifting one finger of a pinch ends the pinch; the other finger doesn't start a drag.
    if (pinch) { pinch = null; endChange('pinch'); }
    drag = null;
    return;
  }
  if (e.type === 'pointerup' && !gestureMoved) togglePlay();
  drag = null;
  pinch = null;
  endChange('drag');
  endChange('pinch');
}
stage.addEventListener('pointerup', releasePointer);
stage.addEventListener('pointercancel', releasePointer);
// Keep iOS from zooming the whole page during a pinch on the preview.
stage.addEventListener('gesturestart', e => e.preventDefault());

/* Frame loop */

let activeIndex = -2;
function tick() {
  if (state.screen === 'editor') {
    if (!preview.paused) {
      playhead = preview.currentTime;
      scrollToTime(playhead);
    } else if (Math.abs(playhead - frameShown) > 0.001 && frameWanted !== playhead) {
      requestFrame(playhead);
    }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const sample = !chunkAt(state.chunks, playhead) && performance.now() < adjustUntil && state.chunks[0];
    if (sample) drawCaption(ctx, overlay.width, overlay.height, [sample], sample.start, state.style);
    else drawCaption(ctx, overlay.width, overlay.height, state.chunks, playhead, state.style);

    $('time-label').textContent = `${fmtPrecise(playhead)} / ${fmtPrecise(duration())}`;
    $('btn-play').classList.toggle('playing', !preview.paused);

    const idx = state.chunks.indexOf(chunkAt(state.chunks, playhead));
    if (idx !== activeIndex) {
      activeIndex = idx;
      for (const b of capsEl.children) b.classList.toggle('active', Number(b.dataset.i) === idx);
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------- Undo ---------- */

const history = [];
let changeSession = null;

function snapshot() {
  history.push(JSON.stringify({ chunks: state.chunks, posY: state.style.posY, size: state.style.size }));
  if (history.length > 100) history.shift();
  updateUndo();
}

// Groups a continuous gesture (typing, dragging a slider) into a single undo step.
function beginChange(kind) {
  if (changeSession === kind) return;
  changeSession = kind;
  snapshot();
}

function endChange(kind) {
  if (changeSession === kind) changeSession = null;
}

function updateUndo() {
  $('btn-undo').disabled = history.length === 0;
}

$('btn-undo').addEventListener('click', () => {
  const last = history.pop();
  if (!last) return;
  changeSession = null;
  const snap = JSON.parse(last);
  state.chunks = snap.chunks;
  for (const [id, key] of [['pos-y', 'posY'], ['size', 'size']]) {
    setStyle(key, snap[key]);
    setSlider($(id), snap[key]);
  }
  if (state.selected >= state.chunks.length) state.selected = -1;
  if (state.selected >= 0) selectChunk(state.selected);
  else renderBlocks();
  updateUndo();
});

/* ---------- Export ---------- */

$('btn-export').addEventListener('click', () => {
  // AudioContext must be created inside the tap, otherwise iOS keeps it suspended.
  audioCtx ??= new AudioContext();
  audioCtx.resume();
  runExport();
});

async function runExport() {
  state.result = null;
  state.rendering = true;
  show('busy');
  setBusy('Video wird gerendert…', 0, 'Bildschirm anlassen und App offen lassen.');
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  try {
    await document.fonts.load(`${state.style.weight} 40px ${state.style.font}`);
    const onProgress = p => { $('busy-bar').style.width = `${Math.round(p * 100)}%`; };
    const job = { file: state.file, url: state.url, chunks: state.chunks, style: state.style, audioCtx, onProgress };
    let blob = null;
    try {
      blob = await renderFast(job);
    } catch (err) {
      console.warn('Fast export failed, falling back to real-time export', err);
    }
    state.exportPath = blob ? 'fast' : 'realtime';
    if (!blob) {
      onProgress(0);
      blob = await renderVideo(job);
    }
    const ext = blob.type.includes('webm') ? 'webm' : 'mp4';
    state.result = new File([blob], `tricaps-${Date.now()}.${ext}`, { type: blob.type });
    setBusy('Fertig!', null, 'Tippe auf Speichern und wähle «Video sichern».');
    document.querySelector('.spinner').hidden = true;
    $('done-check').hidden = false;
    $('btn-save').hidden = false;
    $('btn-back').hidden = false;
  } catch (err) {
    alert(`Export fehlgeschlagen: ${err.message || err}`);
    show('editor');
  } finally {
    state.rendering = false;
    lock?.release?.().catch(() => {});
  }
}

$('btn-save').addEventListener('click', async () => {
  const file = state.result;
  if (!file) return;
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch {}
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

/* ---------- Settings & navigation ---------- */

function openSettings() {
  state.returnTo = state.screen === 'settings' ? state.returnTo : state.screen;
  $('api-key').value = store.get('groqKey', '');
  $('max-words').value = state.style.maxWords;
  show('settings');
}

$('btn-settings').addEventListener('click', openSettings);

$('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.querySelector('meta[name="theme-color"]').content = next === 'light' ? '#f2f2f4' : '#1c1c1e';
});

$('btn-settings-done').addEventListener('click', () => {
  store.set('groqKey', $('api-key').value.trim());
  const mw = Math.min(8, Math.max(1, Number($('max-words').value) || defaultStyle.maxWords));
  if (mw !== state.style.maxWords) {
    state.style.maxWords = mw;
    store.set('maxWords', mw);
    if (state.chunks.length) {
      snapshot();
      state.chunks = groupWords(flatten(state.chunks), state.style);
      renderBlocks();
    }
  }
  show(state.returnTo === 'busy' ? 'start' : state.returnTo);
});

$('btn-back').addEventListener('click', () => {
  if (state.screen === 'settings') { $('btn-settings-done').click(); return; }
  if (state.screen === 'busy') { show('editor'); return; }
  if (state.screen === 'editor' && confirm('Video verwerfen und neu starten?')) show('start');
});

document.fonts.load(`${state.style.weight} 40px ${state.style.font}`).catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

show('start');
