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
uniform int mode;          // 0 = planar YUV, 1 = semi-planar YUV (NV12), 2 = browser-rendered RGB
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
  drawRendered(source, cs) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[3]);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.set('mode', 2);
    this.set('transfer', cs?.transfer === 'pq' ? 1 : 0);
    // Browsers that render HDR at all also map it into the canvas gamut.
    this.set('convertGamut', 0);
    gl.uniform1fv(gl.getUniformLocation(this.program, 'lut'), this.lutFor(cs?.transfer));
    this.render();
  }

  render() {
    const { gl } = this;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // Inverse of the browser's gray response for this transfer: browser output (0..255) -> HDR signal value.
  lutFor(transfer) {
    if (this.luts[transfer]) return this.luts[transfer];
    let lut;
    try {
      lut = measureInverseLut(transfer);
    } catch (err) {
      console.warn('Could not measure the browser HDR response, assuming none', err);
      lut = Float32Array.from({ length: 256 }, (_, i) => i / 255);
    }
    this.luts[transfer] = lut;
    return lut;
  }
}

function measureInverseLut(transfer) {
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
