import { drawCaption } from './captions.js?v=12';

const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

export function pickMime() {
  return MIME_TYPES.find(t => MediaRecorder.isTypeSupported(t)) ?? '';
}

const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));

// Plays the video once in real time and records canvas frames + the original audio.
export async function renderVideo({ url, chunks, style, audioCtx, onProgress }) {
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  // iOS throttles off-screen/detached videos, so keep it in the DOM but invisible.
  Object.assign(v.style, {
    position: 'fixed', left: '0', top: '0', width: '2px', height: '2px',
    opacity: '0.01', pointerEvents: 'none',
  });
  document.body.appendChild(v);

  try {
    await once(v, 'loadeddata');
    const W = v.videoWidth;
    const H = v.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const src = audioCtx.createMediaElementSource(v);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);

    const stream = canvas.captureStream(30);
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));

    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.min(16e6, Math.max(4e6, W * H * 30 * 0.15)),
      audioBitsPerSecond: 192e3,
    });
    const parts = [];
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    const stopped = once(rec, 'stop');

    const draw = () => {
      ctx.drawImage(v, 0, 0, W, H);
      drawCaption(ctx, W, H, chunks, v.currentTime, style);
      onProgress?.(v.duration ? v.currentTime / v.duration : 0);
    };
    const schedule = v.requestVideoFrameCallback
      ? fn => v.requestVideoFrameCallback(fn)
      : fn => requestAnimationFrame(fn);
    const loop = () => {
      draw();
      if (!v.ended) schedule(loop);
    };

    draw();
    rec.start(1000);
    const ended = once(v, 'ended');
    await v.play();
    schedule(loop);
    await ended;
    draw();
    rec.stop();
    await stopped;
    src.disconnect();

    const type = (rec.mimeType || mimeType || 'video/mp4').split(';')[0];
    return new Blob(parts, { type });
  } finally {
    v.pause();
    v.remove();
  }
}
