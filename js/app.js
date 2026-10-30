import { extractWav } from './audio.js?v=16';
import { transcribe } from './transcribe.js?v=16';
import { defaultStyle, groupWords, setChunkText, flatten, chunkAt, drawCaption } from './captions.js?v=16';
import { renderVideo } from './render.js?v=16';
import { renderFast } from './render-fast.js?v=16';

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
const list = $('chunks');

function show(name) {
  state.screen = name;
  for (const s of ['start', 'busy', 'editor', 'settings']) $(`screen-${s}`).hidden = s !== name;
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

const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

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
    const { wav } = await extractWav(file);
    setBusy('Transkribiere…', null, 'Schweizerdeutsch → Hochdeutsch');
    const words = await transcribe(wav, key);
    if (!words.length) throw new Error('Keine Sprache erkannt.');
    state.chunks = groupWords(words, state.style);
    openEditor();
  } catch (err) {
    alert(err.message || String(err));
    show('start');
  }
});

/* ---------- Editor ---------- */

function openEditor() {
  if (preview.src !== state.url) preview.src = state.url;
  renderList();
  show('editor');
}

preview.addEventListener('loadedmetadata', () => {
  const { videoWidth: W, videoHeight: H } = preview;
  stage.style.aspectRatio = `${W} / ${H}`;
  stage.style.height = `min(52dvh, calc((100vw - 32px) * ${H / W}))`;
  requestAnimationFrame(sizeOverlay);
});

function sizeOverlay() {
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(stage.clientWidth * dpr);
  overlay.height = Math.round(stage.clientHeight * dpr);
}
window.addEventListener('resize', sizeOverlay);

// While adjusting, show a sample caption even if none is on screen at the current time.
let adjustUntil = 0;

function setStyle(key, value) {
  state.style[key] = value;
  store.set(key, value);
  adjustUntil = performance.now() + 1200;
}

// WebKit has no native "filled" part for range inputs, so the track gradient reads the fill from --p.
function setSlider(el, value) {
  el.value = value;
  el.style.setProperty('--p', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
}

for (const [id, key] of [['pos-y', 'posY'], ['size', 'size']]) {
  const el = $(id);
  setSlider(el, state.style[key]);
  el.addEventListener('input', () => {
    setSlider(el, el.value);
    setStyle(key, Number(el.value));
  });
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
  drag.moved = true;
  const pos = Math.min(0.95, Math.max(0.08, drag.pos + dy / stage.clientHeight));
  setStyle('posY', pos);
  setSlider($('pos-y'), pos);
});
stage.addEventListener('pointerup', () => {
  if (drag && !drag.moved) {
    if (preview.paused) preview.play(); else preview.pause();
  }
  drag = null;
});
stage.addEventListener('pointercancel', () => { drag = null; });

let activeChunk = null;
function tick() {
  if (state.screen === 'editor') {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const t = preview.currentTime;
    const sample = !chunkAt(state.chunks, t) && performance.now() < adjustUntil && state.chunks[0];
    if (sample) drawCaption(ctx, overlay.width, overlay.height, [sample], sample.start, state.style);
    else drawCaption(ctx, overlay.width, overlay.height, state.chunks, t, state.style);
    const c = chunkAt(state.chunks, t);
    if (c !== activeChunk) {
      activeChunk = c;
      list.querySelectorAll('.chunk.active').forEach(el => el.classList.remove('active'));
      const idx = state.chunks.indexOf(c);
      const li = list.children[idx];
      if (li) {
        li.classList.add('active');
        const editing = document.activeElement?.tagName === 'INPUT';
        if (!preview.paused && !editing) li.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function renderList() {
  list.replaceChildren(...state.chunks.map(chunk => {
    const li = document.createElement('li');
    li.className = 'chunk';

    const time = document.createElement('time');
    time.textContent = fmt(chunk.start);
    time.addEventListener('click', () => { preview.currentTime = chunk.start + 0.01; });

    const input = document.createElement('input');
    input.value = chunk.words.map(w => w.text).join(' ');
    input.enterKeyHint = 'done';
    input.autocapitalize = 'off';
    input.addEventListener('focus', () => {
      preview.pause();
      preview.currentTime = chunk.start + 0.01;
    });
    input.addEventListener('input', () => setChunkText(chunk, input.value));
    input.addEventListener('change', () => {
      if (!input.value.trim()) removeChunk(chunk);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Caption löschen');
    del.addEventListener('click', () => removeChunk(chunk));

    li.append(time, input, del);
    return li;
  }));
  activeChunk = undefined;
}

function removeChunk(chunk) {
  state.chunks = state.chunks.filter(c => c !== chunk);
  renderList();
}

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
      state.chunks = groupWords(flatten(state.chunks), state.style);
      renderList();
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
