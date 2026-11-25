import { drawCaption } from './captions.js?v=40';
import { FPS, videoBitrate } from './render.js?v=40';

const even = n => Math.max(2, Math.round(n / 2) * 2);
const MAX_IN_FLIGHT = 6;

// For HDR footage: browsers' raw decoders hand out frames with broken colours (Safari: pale, washed out), while
// their normal video playback renders HDR correctly. So the clip is played once in a hidden <video>, every frame is
// taken exactly as playback shows it, captioned and encoded as SDR at 30 fps. The audio track is copied untouched.
// Takes as long as the clip.
export async function renderCapture({ file, url, chunks, style, onProgress }) {
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const audioTrack = await input.getPrimaryAudioTrack();

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.setAttribute('muted', '');
  v.setAttribute('playsinline', '');
  // iOS only plays and paints videos that are in the document.
  Object.assign(v.style, {
    position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none',
  });
  document.body.append(v);

  try {
    const loaded = once(v, 'loadedmetadata');
    v.src = url;
    v.load();
    await loaded;
    const W = even(v.videoWidth);
    const H = even(v.videoHeight);
    const duration = v.duration;

    let codec = null;
    for (const c of ['avc', 'vp9']) {
      if (await mb.canEncodeVideo(c, { width: W, height: H })) { codec = c; break; }
    }
    if (!codec) throw new Error('Kein Video-Encoder verfügbar');

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const videoSource = new mb.VideoSampleSource({ codec, bitrate: videoBitrate(W, H), keyFrameInterval: 2 });
    output.addVideoTrack(videoSource, { frameRate: FPS });
    let audioSource = null;
    if (audioTrack?.codec) {
      audioSource = new mb.EncodedAudioPacketSource(audioTrack.codec);
      output.addAudioTrack(audioSource);
    }
    await output.start();

    const audioDone = audioSource ? copyAudio(mb, audioTrack, audioSource) : Promise.resolve();

    // Frames are snapshotted right away and encoded in order; if the encoder falls behind, playback pauses.
    let chain = Promise.resolve();
    let inFlight = 0;
    let failure = null;
    let nextT = 0;
    let ended = false;

    const captured = new Promise((resolve, reject) => {
      const onFrame = (_, meta) => {
        if (failure) return reject(failure);
        const t = meta.mediaTime;
        if (t + 0.002 >= nextT) {
          nextT = Math.max(nextT + 1 / FPS, t + 0.5 / FPS);
          ctx.drawImage(v, 0, 0, W, H);
          drawCaption(ctx, W, H, chunks, t, style);
          const sample = new mb.VideoSample(canvas, { timestamp: t, duration: 1 / FPS });
          inFlight++;
          if (inFlight > MAX_IN_FLIGHT) v.pause();
          chain = chain
            .then(() => videoSource.add(sample))
            .catch(err => { failure ??= err; })
            .finally(() => {
              sample.close();
              inFlight--;
              if (v.paused && !ended && inFlight <= MAX_IN_FLIGHT / 2) v.play().catch(err => { failure ??= err; });
            });
          onProgress?.(duration ? Math.min(1, t / duration) : 0);
        }
        if (!v.ended) v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
      v.addEventListener('ended', () => { ended = true; resolve(); }, { once: true });
      v.addEventListener('error', () => reject(new Error('Das Video konnte nicht abgespielt werden')), { once: true });
      v.play().catch(reject);
    });

    await captured;
    await chain;
    if (failure) throw failure;
    videoSource.close();
    await audioDone;
    audioSource?.close();
    await output.finalize();
    onProgress?.(1);
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
  }
}

async function copyAudio(mb, track, source) {
  const config = await track.getDecoderConfig();
  const sink = new mb.EncodedPacketSink(track);
  let first = true;
  for await (const packet of sink.packets()) {
    await source.add(packet, first ? { decoderConfig: config } : undefined);
    first = false;
  }
}

const once = (el, ev) => new Promise((resolve, reject) => {
  el.addEventListener(ev, resolve, { once: true });
  el.addEventListener('error', () => reject(new Error('Das Video konnte nicht geladen werden')), { once: true });
});
