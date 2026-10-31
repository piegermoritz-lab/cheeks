// HDR (HLG / PQ, e.g. iPhone footage) to SDR BT.709 conversion on the GPU, following BT.2408: HDR reference white
// becomes SDR white, highlights roll off smoothly and BT.2020 colours are mapped into BT.709.
//
// Preferred input is the raw YUV of a decoded frame, so the result doesn't depend on how a browser renders HDR.
// When a browser won't hand out raw planes, the frame is drawn by the browser and its gray response is undone with a
// lookup table measured from a synthetic HDR frame.

export const isHdr = cs => cs?.transfer === 'hlg' || cs?.transfer === 'pq';

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

const VERT = `#version 300 es
in vec2 pos;
out vec2 vUv;
void main() {
  vUv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D planeY;
uniform usampler2D planeU;
uniform usampler2D planeV;
uniform sampler2D rgbTex;
uniform int mode;          // 0 = planar YUV, 1 = semi-planar YUV (NV12), 2 = browser-rendered RGB, 3 = as is
uniform float codeScale;   // 2^(bit depth - 8)
uniform bool fullRange;
uniform int matrix;        // 0 = BT.2020, 1 = BT.709
uniform int transfer;      // 0 = HLG, 1 = PQ
uniform bool convertGamut;
uniform int rotation;      // clockwise degrees / 90
uniform bool flip;
uniform ivec2 lumaSize;
uniform float lut[256];

in vec2 vUv;
out vec4 outColor;

float fromLut(float v) {
  float x = clamp(v, 0.0, 1.0) * 255.0;
  int i = int(floor(x));
  int j = min(i + 1, 255);
  return mix(lut[i], lut[j], x - float(i));
}

float hlgInverse(float e) {
  return e <= 0.5 ? e * e / 3.0 : (exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12.0;
}

float pqToNits(float e) {
  float p = pow(max(e, 0.0), 1.0 / 78.84375);
  return 10000.0 * pow(max(p - 0.8359375, 0.0) / (18.8515625 - 18.6875 * p), 1.0 / 0.1593017578125);
}

float srgb(float l) {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}

vec2 sourceUv(vec2 uv) {
  if (flip) uv.x = 1.0 - uv.x;
  if (rotation == 1) return vec2(uv.y, 1.0 - uv.x);
  if (rotation == 2) return vec2(1.0 - uv.x, 1.0 - uv.y);
  if (rotation == 3) return vec2(1.0 - uv.y, uv.x);
  return uv;
}

void main() {
  if (mode == 3) {
    outColor = vec4(texture(rgbTex, vUv).rgb, 1.0);
    return;
  }
  vec3 sig;
  if (mode == 2) {
    vec3 c = texture(rgbTex, vUv).rgb;
    sig = vec3(fromLut(c.r), fromLut(c.g), fromLut(c.b));
  } else {
    vec2 uv = sourceUv(vUv);
    ivec2 p = min(ivec2(uv * vec2(lumaSize)), lumaSize - 1);
    ivec2 pc = p / 2;
    float yc = float(texelFetch(planeY, p, 0).r) / codeScale;
    float uc;
    float vc;
    if (mode == 0) {
      uc = float(texelFetch(planeU, pc, 0).r) / codeScale;
      vc = float(texelFetch(planeV, pc, 0).r) / codeScale;
    } else {
      uvec2 c = texelFetch(planeU, pc, 0).rg;
      uc = float(c.r) / codeScale;
      vc = float(c.g) / codeScale;
    }
    float y = fullRange ? yc / 255.0 : (yc - 16.0) / 219.0;
    float cb = fullRange ? (uc - 128.0) / 255.0 : (uc - 128.0) / 224.0;
    float cr = fullRange ? (vc - 128.0) / 255.0 : (vc - 128.0) / 224.0;
    sig = matrix == 0
      ? vec3(y + 1.4746 * cr, y - 0.16455 * cb - 0.57135 * cr, y + 1.8814 * cb)
      : vec3(y + 1.5748 * cr, y - 0.1873 * cb - 0.4681 * cr, y + 1.8556 * cb);
  }
  sig = clamp(sig, 0.0, 1.0);

  // Display light with SDR reference white (203 cd/m2) at 1.0.
  vec3 lin;
  if (transfer == 0) {
    vec3 e = vec3(hlgInverse(sig.r), hlgInverse(sig.g), hlgInverse(sig.b));
    float ys = dot(e, vec3(0.2627, 0.6780, 0.0593));
    lin = e * pow(max(ys, 1e-6), 0.2) / 0.2029;
  } else {
    lin = vec3(pqToNits(sig.r), pqToNits(sig.g), pqToNits(sig.b)) / 203.0;
  }
  if (convertGamut) {
    lin = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187) * lin;
  }
  lin = max(lin, 0.0);

  // Soft roll-off of everything brighter than reference white.
  float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  const float knee = 0.9;
  if (l > knee) lin *= (knee + (1.0 - knee) * (1.0 - exp(-(l - knee) / (1.0 - knee)))) / l;
  lin = clamp(lin, 0.0, 1.0);
  outColor = vec4(srgb(lin.r), srgb(lin.g), srgb(lin.b), 1.0);
}`;

const PLANAR = { I420: 8, I420P10: 10, I420P12: 12 };

export class ToneMapper {
  constructor(width, height) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.program = link(gl, VERT, FRAG);
    gl.useProgram(this.program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.textures = ['planeY', 'planeU', 'planeV', 'rgbTex'].map((name, unit) => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, unit === 3 ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, unit === 3 ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(this.program, name), unit);
      return tex;
    });
    this.buffer = null;
    this.luts = {};
    this.rawFailed = false;
    this.scratch = null;
  }

  // A frame the decoder already turned into SDR, undone with the decoder calibration and converted properly.
  drawDecodedSdr(sample, rotation, lut) {
    if (!this.scratch) {
      this.scratch = document.createElement('canvas');
      this.scratch.width = this.canvas.width;
      this.scratch.height = this.canvas.height;
    }
    drawUpright(this.scratch.getContext('2d'), sample, this.canvas.width, this.canvas.height, rotation);
    this.drawRendered(this.scratch, { transfer: 'hlg' }, lut);
  }

  set(name, value, kind = '1i') {
    this.gl[`uniform${kind}`](this.gl.getUniformLocation(this.program, name), value);
  }

  // Draws one decoded mediabunny VideoSample (unrotated pixels, see drawUpright) as upright SDR into this.canvas.
  async drawSample(sample, rotation = 0) {
    const cs = sample.colorSpace;
    if (!this.rawFailed && (sample.format in PLANAR || sample.format === 'NV12')) {
      try {
        await this.drawRaw(sample, cs, rotation);
        return;
      } catch (err) {
        console.warn('Raw HDR frame access failed, using the browser-rendered frame', err);
        this.rawFailed = true;
      }
    }
    if (!this.scratch) {
      this.scratch = document.createElement('canvas');
      this.scratch.width = this.canvas.width;
      this.scratch.height = this.canvas.height;
    }
    drawUpright(this.scratch.getContext('2d'), sample, this.canvas.width, this.canvas.height, rotation);
    this.drawRendered(this.scratch, cs);
  }

  async drawRaw(sample, cs, rotation) {
    const { gl } = this;
    const size = sample.allocationSize();
    if (!this.buffer || this.buffer.byteLength < size) this.buffer = new ArrayBuffer(size);
    const layout = await sample.copyTo(this.buffer);
    const w = sample.visibleRect?.width ?? sample.codedWidth;
    const h = sample.visibleRect?.height ?? sample.codedHeight;
    const cw = Math.ceil(w / 2);
    const ch = Math.ceil(h / 2);
    const bits = PLANAR[sample.format] ?? 8;
    const wide = bits > 8;
    const Arr = wide ? Uint16Array : Uint8Array;
    const bpp = wide ? 2 : 1;
    const upload = (unit, plane, pw, ph, channels) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[unit]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, plane.stride / (bpp * channels));
      const data = new Arr(this.buffer, plane.offset, (plane.stride / bpp) * (ph - 1) + pw * channels);
      const [internal, format] = channels === 2
        ? [wide ? gl.RG16UI : gl.RG8UI, gl.RG_INTEGER]
        : [wide ? gl.R16UI : gl.R8UI, gl.RED_INTEGER];
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, pw, ph, 0, format, wide ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE, data);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    };
    upload(0, layout[0], w, h, 1);
    if (sample.format === 'NV12') {
      upload(1, layout[1], cw, ch, 2);
      this.set('mode', 1);
    } else {
      upload(1, layout[1], cw, ch, 1);
      upload(2, layout[2], cw, ch, 1);
      this.set('mode', 0);
    }
    this.set('codeScale', 2 ** (bits - 8), '1f');
    this.set('fullRange', cs?.fullRange ? 1 : 0);
    this.set('matrix', cs?.matrix === 'bt709' ? 1 : 0);
    this.set('transfer', cs?.transfer === 'pq' ? 1 : 0);
    this.set('convertGamut', cs?.primaries === 'bt709' ? 0 : 1);
    this.set('rotation', (((rotation % 360) + 360) % 360) / 90);
    this.set('flip', 0);
    gl.uniform2i(gl.getUniformLocation(this.program, 'lumaSize'), w, h);
    this.render();
  }

  // Converts an image the browser already rendered (canvas, <video>) whose gray axis is described by a measured LUT.
  drawRendered(source, cs, measuredLut = null) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[3]);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const lut = measuredLut ?? this.lutFor(cs?.transfer);
    // Without a trustworthy measurement a second conversion would only make things worse.
    this.set('mode', lut ? 2 : 3);
    this.set('transfer', cs?.transfer === 'pq' ? 1 : 0);
    // Browsers that render HDR at all also map it into the canvas gamut.
    this.set('convertGamut', 0);
    if (lut) gl.uniform1fv(gl.getUniformLocation(this.program, 'lut'), lut);
    this.render();
  }

  render() {
    const { gl } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Inverse of the browser's gray response for this transfer: browser output (0..255) -> HDR signal value.
  // Null when it can't be measured, e.g. when the browser ignores the colour space of a synthetic frame (its
  // response then matches plain SDR) while decoded frames do get converted.
  lutFor(transfer) {
    if (transfer in this.luts) return this.luts[transfer];
    let lut = null;
    try {
      const hdr = measureResponse(transfer);
      const sdr = measureResponse('bt709');
      if (hdr.some((v, i) => Math.abs(v - sdr[i]) > 6)) lut = measureInverseLut(transfer);
    } catch (err) {
      console.warn('Could not measure the browser HDR response', err);
    }
    this.luts[transfer] = lut;
    return lut;
  }
}

// Browser output (average of R, G, B, 0..255) for a synthetic gray ramp of 256 signal levels in this transfer.
export function measureResponse(transfer) {
  const N = 256;
  const data = new Uint8Array(N * 2 + (N / 2) * 2);
  for (let x = 0; x < N; x++) data[x] = data[N + x] = 16 + Math.round((219 * x) / (N - 1));
  data.fill(128, N * 2);
  const frame = new VideoFrame(data, {
    format: 'I420',
    codedWidth: N,
    codedHeight: 2,
    timestamp: 0,
    colorSpace: { primaries: 'bt2020', transfer, matrix: 'bt2020-ncl', fullRange: false },
  });
  const c = document.createElement('canvas');
  c.width = N;
  c.height = 2;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frame, 0, 0);
  frame.close();
  const px = ctx.getImageData(0, 0, N, 1).data;
  const out = [];
  for (let x = 0; x < N; x++) out.push((px[x * 4] + px[x * 4 + 1] + px[x * 4 + 2]) / 3);
  return out;
}

function measureInverseLut(transfer) {
  const N = 256;
  const out = measureResponse(transfer);
  // Invert the (monotonic) response by linear interpolation.
  const lut = new Float32Array(256);
  let k = 0;
  for (let o = 0; o < 256; o++) {
    while (k < N - 2 && out[k + 1] < o) k++;
    const a = out[k];
    const b = out[k + 1];
    const t = b > a ? Math.min(1, Math.max(0, (o - a) / (b - a))) : 0;
    lut[o] = (k + t) / (N - 1);
  }
  if (out[N - 1] - out[0] < 32) throw new Error('flat response');
  return lut;
}

function link(gl, vs, fs) {
  const program = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(program, sh);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  return program;
}

/* Round-trip calibration: some browsers (Safari) colour-manage video differently on the way into the encoder than
   on the way back out, so an exported clip plays brighter and paler than the canvas it was made from. Encoding a
   few gray levels and decoding them again measures that drift; Grade applies the inverse before encoding. */

const LEVELS = Array.from({ length: 16 }, (_, i) => Math.round((i * 255) / 15));

export async function measureRoundTrip(mb, codec) {
  const BAND = 16;
  const W = BAND * LEVELS.length;
  const H = 64;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  LEVELS.forEach((v, i) => {
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(i * BAND, 0, BAND, H);
  });
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
  const source = new mb.CanvasSource(canvas, { codec, bitrate: 8e6 });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  await source.add(0, 1 / 30);
  await source.add(1 / 30, 1 / 30);
  source.close();
  await output.finalize();

  const input = new mb.Input({ source: new mb.BlobSource(new Blob([target.buffer])), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sample = await new mb.VideoSampleSink(track).getSample(0);
  const back = new OffscreenCanvas(W, H);
  const bctx = back.getContext('2d', { willReadFrequently: true });
  drawUpright(bctx, sample, W, H, track.rotation ?? 0);
  sample.close();
  const out = LEVELS.map((_, i) => {
    const d = bctx.getImageData(i * BAND + BAND / 2, H / 2, 1, 1).data;
    return (d[0] + d[1] + d[2]) / 3;
  });
  return { levels: LEVELS, out, colorSpace: await track.getColorSpace() };
}

// Encode value to write so that the round trip yields the wanted value; null when the drift is negligible.
export function gradeLut(levels, out) {
  if (levels.every((v, i) => Math.abs(out[i] - v) <= 3)) return null;
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) return null;
  const lut = new Uint8Array(256);
  let k = 0;
  for (let want = 0; want < 256; want++) {
    while (k < out.length - 2 && out[k + 1] < want) k++;
    const t = Math.min(1, Math.max(0, (want - out[k]) / (out[k + 1] - out[k])));
    lut[want] = Math.round(levels[k] + t * (levels[k + 1] - levels[k]));
  }
  return lut;
}

const GRADE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D img;
uniform sampler2D lut;
in vec2 vUv;
out vec4 outColor;
float map(float v) { return texelFetch(lut, ivec2(int(round(clamp(v, 0.0, 1.0) * 255.0)), 0), 0).r; }
void main() {
  vec3 c = texture(img, vUv).rgb;
  outColor = vec4(map(c.r), map(c.g), map(c.b), 1.0);
}`;

export class Grade {
  constructor(width, height, lut) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    const program = link(gl, VERT, GRADE_FRAG);
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = (unit, filter) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.img = tex(0, gl.NEAREST);
    gl.uniform1i(gl.getUniformLocation(program, 'img'), 0);
    tex(1, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, lut);
    gl.uniform1i(gl.getUniformLocation(program, 'lut'), 1);
  }

  apply(source) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.img);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

/* Decoder calibration: Safari decodes HLG video straight to 8-bit SDR with its own, washed-out mapping. A bundled
   HLG clip with 16 known gray levels (same codec and tagging as iPhone footage) is decoded the same way; the inverse
   of what comes out restores the HLG signal, which ToneMapper then converts properly. */

const decoderCache = new Map();

export function decoderLut(mb, url = 'assets/hlg-ramp.mp4', force = false) {
  const key = `${url}|${force}`;
  if (!decoderCache.has(key)) decoderCache.set(key, measureDecoder(mb, url, force).catch(err => {
    console.warn('Decoder calibration failed', err);
    return null;
  }));
  return decoderCache.get(key);
}

export async function measureDecoder(mb, url, force = false) {
  const blob = await (await fetch(url)).blob();
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return null;
  const sample = await new mb.VideoSampleSink(track).getSample(0);
  if (!sample) return null;
  // Raw HDR frames are converted exactly anyway; no calibration needed.
  if (isHdr(sample.colorSpace) && !force) {
    sample.close();
    return null;
  }
  const W = track.displayWidth;
  const H = track.displayHeight;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  drawUpright(ctx, sample, W, H, track.rotation ?? 0);
  sample.close();
  const bands = 16;
  const out = Array.from({ length: bands }, (_, i) => {
    const d = ctx.getImageData(Math.floor(((i + 0.5) * W) / bands), Math.floor(H / 2), 1, 1).data;
    return (d[0] + d[1] + d[2]) / 3;
  });
  for (let i = 1; i < bands; i++) if (out[i] < out[i - 1]) return null;
  if (out[bands - 1] - out[0] < 64) return null;
  const lut = new Float32Array(256);
  let k = 0;
  for (let o = 0; o < 256; o++) {
    while (k < bands - 2 && out[k + 1] < o) k++;
    const a = out[k];
    const b = out[k + 1];
    const t = b > a ? Math.min(1, Math.max(0, (o - a) / (b - a))) : 0;
    lut[o] = (k + t) / (bands - 1);
  }
  lut.response = out;
  return lut;
}
