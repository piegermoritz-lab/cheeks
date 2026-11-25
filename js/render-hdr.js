import { drawCaption, chunkAt } from './captions.js?v=40';
import { FPS, videoBitrate } from './render.js?v=40';

// HDR clips (iPhone HLG): no colour conversion at all. Decoded frames keep their HLG signal (Safari hands it out
// untouched as 8-bit YUV), captions are blended straight into the Y/U/V planes, and the result is encoded and tagged
// as BT.2020 HLG again, so it plays exactly like the original. Audio is copied.

const HDR_COLOR = { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: false };
// Caption white as HLG signal level: a bit above reference white (75 %) so text stays clearly white next to bright
// HDR highlights without glaring.
const WHITE = 0.85;
const even = n => Math.max(2, Math.round(n / 2) * 2);

export async function renderHdr({ file, chunks, style, onProgress }) {
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) return null;
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode()) || !(await track.hasHighDynamicRange())) return null;
  const audioTrack = await input.getPrimaryAudioTrack();
  const duration = await input.computeDuration();
  const rotation = (((track.rotation ?? 0) % 360) + 360) % 360;
  const CW = even(track.codedWidth);
  const CH = even(track.codedHeight);
  const bitrate = videoBitrate(CW, CH);
  // H.264 plays everywhere (Photos included); the HLG tagging works the same as with HEVC.
  if (!(await mb.canEncodeVideo('avc', { width: CW, height: CH, bitrate }))) throw new Error(`kein H.264-Encoder für ${CW}x${CH}`);

  const HlgEncoder = hlgEncoderClass(mb);
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  HlgEncoder.active = true;
  try {
    const videoSource = new mb.VideoSampleSource({ codec: 'avc', bitrate, keyFrameInterval: 2 });
    // Frames stay in stored orientation; the rotation is kept as metadata like in the original.
    output.addVideoTrack(videoSource, { frameRate: FPS, rotation });
    let audioSource = null;
    if (audioTrack?.codec) {
      audioSource = new mb.EncodedAudioPacketSource(audioTrack.codec);
      output.addAudioTrack(audioSource);
    }
    await output.start();

    const captions = new CaptionMasks(chunks, style, CW, CH, rotation);
    // Safe to reuse: each frame is fully handed to the encoder before the next one is written.
    const yuv = new Uint8Array(CW * CH * 1.5);
    let nextT = -Infinity;
    let frames = 0;
    for await (const sample of new mb.VideoSampleSink(track).samples()) {
      try {
        const t = sample.timestamp;
        if (t + 0.002 < nextT) continue;
        nextT = Math.max(nextT + 1 / FPS, t + 0.5 / FPS);
        await toLimitedI420(sample, yuv, CW, CH);
        captions.burn(yuv, t);
        const out = new mb.VideoSample(yuv, {
          format: 'I420', codedWidth: CW, codedHeight: CH, timestamp: t, duration: 1 / FPS, colorSpace: HDR_COLOR,
        });
        await videoSource.add(out);
        out.close();
        frames++;
        onProgress?.(duration ? Math.min(0.97, t / duration) : 0);
      } finally {
        sample.close();
      }
    }
    if (!frames) throw new Error('Keine Bilder dekodiert');
    videoSource.close();
    if (audioSource) {
      await copyAudio(mb, audioTrack, audioSource);
      audioSource.close();
    }
    await output.finalize();
  } finally {
    HlgEncoder.active = false;
  }
  onProgress?.(1);
  return new Blob([target.buffer], { type: 'video/mp4' });
}

// Mediabunny picks the encoder config (incl. Safari-safe H.264 profiles) and runs this in place of its own
// WebCodecs encoder while an HDR export is active. It only adds the HLG colour space to the stream metadata, which
// becomes the file's colour box; browsers don't reliably report it themselves.
let hlgEncoder = null;
function hlgEncoderClass(mb) {
  if (hlgEncoder) return hlgEncoder;
  hlgEncoder = class extends mb.CustomVideoEncoder {
    static supports(codec) {
      return hlgEncoder.active && codec === 'avc';
    }

    async init() {
      // Mediabunny hands over its first candidate config; fall back to other H.264 profiles if it isn't supported.
      let config = this.config;
      if (!(await VideoEncoder.isConfigSupported(config)).supported) {
        const level = config.codec.slice(-2);
        for (const codec of [`avc1.4240${level}`, `avc1.4d40${level}`, `avc1.6400${level}`, 'avc1.42e01f']) {
          const candidate = { ...config, codec };
          if ((await VideoEncoder.isConfigSupported(candidate)).supported) {
            config = candidate;
            break;
          }
        }
      }
      this.encoder = new VideoEncoder({
        output: (chunk, meta) => {
          const m = meta?.decoderConfig ? { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: HDR_COLOR } } : meta;
          this.onPacket(mb.EncodedPacket.fromEncodedChunk(chunk), m);
        },
        error: err => this.onError(err),
      });
      this.encoder.configure(config);
    }

    async encode(sample, options) {
      const frame = sample.toVideoFrame();
      this.encoder.encode(frame, options);
      frame.close();
      while (this.encoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 4));
    }

    async flush() {
      await this.encoder.flush();
    }

    close() {
      if (this.encoder.state !== 'closed') this.encoder.close();
    }
  };
  hlgEncoder.active = false;
  mb.registerEncoder(hlgEncoder);
  return hlgEncoder;
}

// Copies a decoded frame (I420 / I420P10 / I420P12 / NV12) into 8-bit limited-range I420 without changing colours:
// only bit depth and value range are adapted, the signal itself (HLG, BT.2020) passes through.
async function toLimitedI420(sample, out, CW, CH) {
  const fmt = sample.format;
  const bits = fmt === 'I420P10' ? 10 : fmt === 'I420P12' ? 12 : 8;
  if (!['I420', 'I420P10', 'I420P12', 'NV12'].includes(fmt)) throw new Error(`Bildformat ${fmt} nicht unterstützt`);
  const size = sample.allocationSize();
  if (!scratch || scratch.byteLength < size) scratch = new ArrayBuffer(size);
  const layout = await sample.copyTo(scratch);
  const w = Math.min(CW, sample.visibleRect?.width ?? sample.codedWidth);
  const h = Math.min(CH, sample.visibleRect?.height ?? sample.codedHeight);
  if (w < CW || h < CH) {
    out.fill(16, 0, CW * CH);
    out.fill(128, CW * CH);
  }
  const full = !!sample.colorSpace?.fullRange;
  const yl = rangeLut(full, false);
  const cl = rangeLut(full, true);
  const shift = bits - 8;
  const b8 = new Uint8Array(scratch);
  const b16 = bits > 8 ? new Uint16Array(scratch, 0, scratch.byteLength >> 1) : null;
  const at = b16 ? (off, i) => b16[(off >> 1) + i] >> shift : (off, i) => b8[off + i];

  for (let y = 0; y < h; y++) {
    const src = layout[0].offset + y * layout[0].stride;
    const dst = y * CW;
    for (let x = 0; x < w; x++) out[dst + x] = yl[at(src, x)];
  }
  const cw = w >> 1;
  const ch = h >> 1;
  const U = CW * CH;
  const V = U + (CW >> 1) * (CH >> 1);
  for (let y = 0; y < ch; y++) {
    const dst = y * (CW >> 1);
    if (fmt === 'NV12') {
      const src = layout[1].offset + y * layout[1].stride;
      for (let x = 0; x < cw; x++) {
        out[U + dst + x] = cl[b8[src + 2 * x]];
        out[V + dst + x] = cl[b8[src + 2 * x + 1]];
      }
    } else {
      const su = layout[1].offset + y * layout[1].stride;
      const sv = layout[2].offset + y * layout[2].stride;
      for (let x = 0; x < cw; x++) {
        out[U + dst + x] = cl[at(su, x)];
        out[V + dst + x] = cl[at(sv, x)];
      }
    }
  }
}
let scratch = null;

const luts = {};
function rangeLut(full, chroma) {
  const key = `${full}${chroma}`;
  if (luts[key]) return luts[key];
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = !full ? v : chroma ? Math.round(128 + ((v - 128) * 224) / 255) : Math.round(16 + (v * 219) / 255);
  }
  return (luts[key] = lut);
}

// Renders each caption once (in display orientation, then turned into the stored orientation) and blends it into
// the luma plane at HLG reference white; chroma under the text is pulled to neutral.
class CaptionMasks {
  constructor(chunks, style, CW, CH, rotation) {
    Object.assign(this, { chunks, style, CW, CH, rotation, current: null, mask: null });
    this.DW = rotation % 180 ? CH : CW;
    this.DH = rotation % 180 ? CW : CH;
    this.display = document.createElement('canvas');
    this.display.width = this.DW;
    this.display.height = this.DH;
    this.coded = document.createElement('canvas');
    this.coded.width = CW;
    this.coded.height = CH;
  }

  burn(yuv, t) {
    const chunk = chunkAt(this.chunks, t);
    if (!chunk) return;
    if (chunk !== this.current) {
      this.current = chunk;
      this.mask = this.build(chunk);
    }
    const m = this.mask;
    if (!m) return;
    const { CW, CH } = this;
    const peak = 16 + WHITE * 219;
    for (let y = m.y0; y < m.y1; y++) {
      for (let x = m.x0; x < m.x1; x++) {
        const k = (y - m.y0) * m.w + (x - m.x0);
        const a = m.alpha[k];
        if (!a) continue;
        const i = y * CW + x;
        const target = 16 + (m.luma[k] / 255) * (peak - 16);
        yuv[i] += ((target - yuv[i]) * a) / 255;
      }
    }
    const U = CW * CH;
    const V = U + (CW >> 1) * (CH >> 1);
    for (let y = m.y0 >> 1; y < (m.y1 + 1) >> 1; y++) {
      for (let x = m.x0 >> 1; x < (m.x1 + 1) >> 1; x++) {
        let a = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const px = 2 * x + dx - m.x0;
            const py = 2 * y + dy - m.y0;
            if (px >= 0 && py >= 0 && px < m.w && py < m.y1 - m.y0) a += m.alpha[py * m.w + px];
          }
        }
        if (!a) continue;
        const f = a / 1020;
        const i = y * (CW >> 1) + x;
        yuv[U + i] += (128 - yuv[U + i]) * f;
        yuv[V + i] += (128 - yuv[V + i]) * f;
      }
    }
  }

  build(chunk) {
    const { DW, DH, CW, CH, rotation } = this;
    const d = this.display.getContext('2d');
    d.clearRect(0, 0, DW, DH);
    drawCaption(d, DW, DH, [chunk], (chunk.start + chunk.end) / 2, { ...this.style, pop: false });
    const c = this.coded.getContext('2d', { willReadFrequently: true });
    c.clearRect(0, 0, CW, CH);
    c.save();
    c.translate(CW / 2, CH / 2);
    c.rotate((-rotation * Math.PI) / 180);
    c.drawImage(this.display, -DW / 2, -DH / 2);
    c.restore();
    const px = c.getImageData(0, 0, CW, CH).data;
    let x0 = CW, y0 = CH, x1 = 0, y1 = 0;
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        if (px[(y * CW + x) * 4 + 3]) {
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
      }
    }
    if (x1 <= x0) return null;
    const w = x1 - x0;
    const alpha = new Uint8Array(w * (y1 - y0));
    const luma = new Uint8Array(w * (y1 - y0));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const s = (y * CW + x) * 4;
        const k = (y - y0) * w + (x - x0);
        alpha[k] = px[s + 3];
        // getImageData returns un-premultiplied colour, i.e. the text colour itself.
        const lum = 0.2126 * px[s] + 0.7152 * px[s + 1] + 0.0722 * px[s + 2];
        luma[k] = Math.min(255, Math.round(lum));
      }
    }
    return { x0, y0, x1, y1, w, alpha, luma };
  }
}

async function copyAudio(mb, track, source) {
  const config = await track.getDecoderConfig();
  let first = true;
  for await (const packet of new mb.EncodedPacketSink(track).packets()) {
    await source.add(packet, first ? { decoderConfig: config } : undefined);
    first = false;
  }
}
