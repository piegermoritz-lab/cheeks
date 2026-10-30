import { extractAudio } from './audio.js?v=20';
import { transcribe } from './transcribe.js?v=20';
import {
  defaultStyle, groupWords, setChunkText, flatten, chunkAt, drawCaption, splitChunk, mergeWithNext, moveEdge,
} from './captions.js?v=20';
import { renderVideo } from './render.js?v=20';
import { renderFast } from './render-fast.js?v=20';

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
    const words = await transcribe(audio, key);
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
const duration = () => (Number.isFinite(preview.duration) ? preview.duration : 0);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function openEditor() {
  if (preview.src !== state.url) preview.src = state.url;
  playhead = 0;
  closePanels();
  show('editor');
  layoutStage();
  if (preview.readyState >= 1) buildTimeline();
}

preview.addEventListener('loadedmetadata', () => {
  layoutStage();
  buildTimeline();
});

// Fit the preview into whatever space is left above the timeline.
function layoutStage() {
  const wrap = $('stage-wrap');
  const W = preview.videoWidth || 9;
  const H = preview.videoHeight || 16;
  const w = Math.min(wrap.clientWidth, wrap.clientHeight * (W / H));
  stage.style.width = `${Math.floor(w)}px`;
  stage.style.height = `${Math.floor(w * (H / W))}px`;
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(w * (H / W) * dpr);
}
new ResizeObserver(() => { if (state.screen === 'editor') layoutStage(); }).observe($('stage-wrap'));

function buildTimeline() {
  track.style.width = `${Math.ceil(duration() * PPS)}px`;
  renderBlocks();
  scrollToTime(playhead);
  buildThumbs();
}

// Frames are grabbed with a second, hidden video element by seeking; a capped number of frames is reused across tiles.
let thumbJob = 0;
async function buildThumbs() {
  const job = ++thumbJob;
  const dur = duration();
  const W = preview.videoWidth;
  const H = preview.videoHeight;
  if (!dur || !W) return;
  const dpr = window.devicePixelRatio || 1;
  const trackW = Math.ceil(dur * PPS);
  const tileH = 44;
  const tileW = tileH * (W / H);
  const scale = Math.min(dpr, 16000 / trackW);
  thumbs.width = Math.round(trackW * scale);
  thumbs.height = Math.round(tileH * dpr);
  thumbs.style.width = `${trackW}px`;
  const ctx = thumbs.getContext('2d');
  ctx.clearRect(0, 0, thumbs.width, thumbs.height);

  const tiles = Math.ceil(trackW / tileW);
  const frames = Math.min(tiles, 30);
  const v = el('video', { muted: true, playsInline: true, preload: 'auto', src: state.url });
  v.muted = true;
  await new Promise(r => { v.addEventListener('loadeddata', r, { once: true }); v.load(); });
  for (let f = 0; f < frames && job === thumbJob; f++) {
    const t = Math.min(dur - 0.05, ((f + 0.5) / frames) * dur);
    await new Promise(r => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; });
    if (job !== thumbJob) break;
    for (let k = 0; k < tiles; k++) {
      if (Math.min(frames - 1, Math.floor((k / tiles) * frames)) !== f) continue;
      ctx.drawImage(v, k * tileW * scale, 0, tileW * scale, thumbs.height);
    }
  }
  v.removeAttribute('src');
  v.load();
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

// Drag the caption up/down on the preview; a tap without movement plays/pauses.
let drag = null;
stage.addEventListener('pointerdown', e => {
  drag = { y: e.clientY, pos: state.style.posY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', e => {
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.abs(dy) < 6) return;
  if (!drag.moved) beginChange('drag');
  drag.moved = true;
  const pos = Math.min(0.95, Math.max(0.08, drag.pos + dy / stage.clientHeight));
  setStyle('posY', pos);
  setSlider($('pos-y'), pos);
});
stage.addEventListener('pointerup', () => {
  if (drag && !drag.moved) togglePlay();
  drag = null;
  endChange('drag');
});
stage.addEventListener('pointercancel', () => { drag = null; endChange('drag'); });

/* Frame loop */

let activeIndex = -2;
function tick() {
  if (state.screen === 'editor') {
    if (!preview.paused) {
      playhead = preview.currentTime;
      scrollToTime(playhead);
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
