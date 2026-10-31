import { drawCaption } from './captions.js?v=36';
import { FPS, videoBitrate } from './render.js?v=36';
import { ToneMapper, drawUpright, isHdr, measureRoundTrip, gradeLut, Grade, decoderLut } from './hdr.js?v=36';

const even = n => Math.max(2, Math.round(n / 2) * 2);

// Decodes frames straight from the file with WebCodecs, draws captions and re-encodes them as fast as the device
// allows. The audio track is copied without re-encoding. Returns null when this browser/file can't take this path.
export async function renderFast({ file, chunks, style, onProgress }) {
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) return null;
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');

  const probe = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await probe.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return null;
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
    // HDR frames (e.g. iPhone HLG, where the browser hands them out undecoded) are tone mapped ourselves. Safari
    // already decodes HDR to SDR, so this is decided per frame, not per track.
    let mapper = null;
    let grade = null;
    const hlgTrack = (await track.getColorSpace())?.transfer === 'hlg';
    const sdrLut = hlgTrack ? await decoderLut(mb) : null;
    try {
      const rt = await measureRoundTrip(mb, codec);
      const lut = gradeLut(rt.levels, rt.out);
      if (lut) grade = new Grade(W, H, lut);
    } catch (err) {
      console.warn('Round-trip calibration failed', err);
    }

    const conversion = await mb.Conversion.init({
      input,
      output,
      showWarnings: false,
      video: {
        codec,
        quality: new mb.Quality({ bitrate: videoBitrate(W, H), bitrateMode: 'variable' }),
        frameRate: FPS,
        forceTranscode: true,
        // Undo the track's own rotation so process() gets the untouched decoded frame (incl. raw HDR planes);
        // drawing / tone mapping applies the rotation itself and writes upright frames.
        rotate: (360 - rotation) % 360,
        allowTransformationMetadata: false,
        processedWidth: W,
        processedHeight: H,
        process: async sample => {
          if (isHdr(sample.colorSpace)) {
            mapper ??= new ToneMapper(W, H);
            await mapper.drawSample(sample, rotation);
            ctx.drawImage(mapper.canvas, 0, 0, W, H);
          } else if (sdrLut) {
            mapper ??= new ToneMapper(W, H);
            mapper.drawDecodedSdr(sample, rotation, sdrLut);
            ctx.drawImage(mapper.canvas, 0, 0, W, H);
          } else {
            drawUpright(ctx, sample, W, H, rotation);
          }
          drawCaption(ctx, W, H, chunks, sample.timestamp, style);
          return grade ? grade.apply(canvas) : canvas;
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
