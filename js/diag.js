import { ToneMapper, drawUpright, measureResponse, measureRoundTrip, gradeLut, inspectDecoder, decoderLut } from './hdr.js?v=36';

// Collects what this browser does with the loaded video's frames, to tune HDR handling on devices we can't test.
export async function diagnose(file, video) {
  const lines = [];
  const log = (k, v) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  log('ua', navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) return 'keine Videospur';
  log('codec', await vt.getCodecParameterString());
  log('track', { ...(await vt.getColorSpace()), hdr: await vt.hasHighDynamicRange(), rot: vt.rotation, w: vt.displayWidth, h: vt.displayHeight, decode: await vt.canDecode() });

  const first = await vt.getFirstTimestamp();
  const dur = await input.computeDuration();
  const sample = await new mb.VideoSampleSink(vt).getSample(first + Math.min(1, dur / 2));
  log('sample', { format: sample.format, ...sample.colorSpace, cw: sample.codedWidth, ch: sample.codedHeight, rot: sample.rotation });

  try {
    const buf = new ArrayBuffer(sample.allocationSize());
    const layout = await sample.copyTo(buf);
    const wide = /P1[02]/.test(sample.format ?? '');
    const at = (plane, x, y, ch = 1) => {
      const { offset, stride } = layout[plane];
      const i = offset + y * stride + x * (wide ? 2 : 1) * ch;
      return wide ? new DataView(buf).getUint16(i, true) : new Uint8Array(buf)[i];
    };
    const w = sample.codedWidth;
    const h = sample.codedHeight;
    log('raw', { planes: layout.length, Y: at(0, w >> 1, h >> 1), U: at(1, w >> 2, h >> 2, layout.length === 2 ? 2 : 1) });
  } catch (err) {
    log('raw', `copyTo failed: ${err.message}`);
  }

  const W = 90;
  const H = Math.round((W * vt.displayHeight) / vt.displayWidth);
  const pts = [[0.5, 0.5], [0.25, 0.2], [0.75, 0.2], [0.25, 0.8], [0.75, 0.8]];
  const read = src => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, W, H);
    return pts.map(([x, y]) => [...ctx.getImageData(Math.floor(x * W), Math.floor(y * H), 1, 1).data].slice(0, 3).join('/')).join(' ');
  };
  const browser = document.createElement('canvas');
  browser.width = W;
  browser.height = H;
  drawUpright(browser.getContext('2d'), sample, W, H, vt.rotation);
  log('browser', read(browser));
  try {
    const raw = new ToneMapper(W, H);
    await raw.drawSample(sample, vt.rotation);
    log(raw.rawFailed ? 'mapper(fallback)' : 'mapper(raw)', read(raw.canvas));
    const fb = new ToneMapper(W, H);
    fb.rawFailed = true;
    await fb.drawSample(sample, vt.rotation);
    log('mapper(forced fallback)', read(fb.canvas));
  } catch (err) {
    log('mapper', `failed: ${err.message}`);
  }
  sample.close();

  for (const url of ['assets/hlg-ramp-hev1.mp4', 'assets/hlg-ramp-hvc1.mp4']) {
    const r = await inspectDecoder(mb, url, true);
    const { lut, url: u, ...info } = r;
    log(`clip ${u.split('-').pop()}`, { ...info, lut: !!lut });
  }
  const lut = await decoderLut(mb);
  if (lut) {
    const s2 = await new mb.VideoSampleSink(vt).getSample(first + Math.min(1, dur / 2));
    const m = new ToneMapper(W, H);
    m.drawDecodedSdr(s2, vt.rotation, lut);
    s2.close();
    log('mapper(decoded sdr)', read(m.canvas));
  } else {
    log('mapper(decoded sdr)', 'no calibration');
  }

  // What normal playback shows at the same moment (needs the video to have played once on iOS).
  if (video?.readyState >= 2) {
    const t = first + Math.min(1, dur / 2);
    video.pause();
    await new Promise(r => {
      const timer = setTimeout(r, 3000);
      video.addEventListener('seeked', () => { clearTimeout(timer); r(); }, { once: true });
      video.currentTime = t;
    });
    log('video element', read(video));
  } else {
    log('video element', `not loaded (readyState ${video?.readyState})`);
  }
  for (const codec of ['avc']) {
    try {
      const rt = await measureRoundTrip(mb, codec);
      log(`roundtrip ${codec}`, `${rt.out.map(v => Math.round(v)).join(' ')} ${JSON.stringify(rt.colorSpace)} grade=${!!gradeLut(rt.levels, rt.out)}`);
    } catch (err) {
      log(`roundtrip ${codec}`, `failed: ${err.message}`);
    }
  }
  for (const t of ['hlg', 'pq', 'bt709']) {
    try {
      const r = measureResponse(t);
      log(`resp ${t}`, [0, 64, 128, 191, 255].map(i => Math.round(r[i])).join(' '));
    } catch (err) {
      log(`resp ${t}`, `failed: ${err.message}`);
    }
  }
  return lines.join('\n');
}
