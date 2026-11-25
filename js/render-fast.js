import { drawCaption } from './captions.js?v=39';
import { FPS, videoBitrate } from './render.js?v=39';

const even = n => Math.max(2, Math.round(n / 2) * 2);

// Draws a sample's unrotated pixels upright into a W×H canvas. Callers pass the track's rotation: a sample's own
// rotation field can't be relied on once Mediabunny has re-rendered the frame.
export function drawUpright(ctx, sample, W, H, rotation = 0) {
  const r = ((rotation % 360) + 360) % 360;
  const [dw, dh] = r % 180 ? [H, W] : [W, H];
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(sample.toCanvasImageSource(), -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// SDR clips: decodes frames straight from the file with WebCodecs, draws captions and re-encodes them as fast as
// the device allows. The audio track is copied without re-encoding. Returns null when this browser/file can't take
// this path. HDR clips go through render-capture.js instead.
export async function renderFast({ file, chunks, style, onProgress }) {
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) return null;
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');

  const probe = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode()) || (await track.hasHighDynamicRange())) return null;
  const W = even(track.displayWidth);
  const H = even(track.displayHeight);
  const rotation = track.rotation ?? 0;

  for (const codec of ['avc', 'vp9']) {
    if (!(await mb.canEncodeVideo(codec, { width: W, height: H }))) continue;

    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');

    const conversion = await mb.Conversion.init({
      input,
      output,
      showWarnings: false,
      video: {
        codec,
        quality: new mb.Quality({ bitrate: videoBitrate(W, H), bitrateMode: 'variable' }),
        frameRate: FPS,
        forceTranscode: true,
        // Undo the track's own rotation so process() gets the untouched decoded frame; drawUpright applies the
        // rotation itself and writes upright frames.
        rotate: (360 - rotation) % 360,
        allowTransformationMetadata: false,
        processedWidth: W,
        processedHeight: H,
        process: sample => {
          drawUpright(ctx, sample, W, H, rotation);
          drawCaption(ctx, W, H, chunks, sample.timestamp, style);
          return canvas;
        },
      },
    });

    const hasVideo = conversion.utilizedTracks.some(t => t.isVideoTrack());
    if (!conversion.isValid || !hasVideo) continue;

    conversion.onProgress = p => onProgress?.(p);
    await conversion.execute();
    return new Blob([target.buffer], { type: 'video/mp4' });
  }
  return null;
}
