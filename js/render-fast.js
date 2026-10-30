import { drawCaption } from './captions.js?v=18';

const even = n => Math.max(2, Math.round(n / 2) * 2);

// Decodes frames straight from the file with WebCodecs, draws captions and re-encodes them as fast as the device
// allows. The audio track is copied without re-encoding. Returns null when this browser/file can't take this path.
export async function renderFast({ file, chunks, style, onProgress }) {
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) return null;
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');

  const probe = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return null;
  // Explicit output size: some encoders reject the source's codec profile unless Mediabunny picks the config itself.
  const W = even(track.displayWidth);
  const H = even(track.displayHeight);

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
        width: W,
        height: H,
        fit: 'fill',
        quality: mb.QUALITY_VERY_HIGH,
        forceTranscode: true,
        allowTransformationMetadata: false,
        process: sample => {
          sample.draw(ctx, 0, 0, W, H);
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
