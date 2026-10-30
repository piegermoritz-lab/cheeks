const TARGET_RATE = 16000;

// Safari can't decodeAudioData() most iPhone videos ("Decoding failed"), so the audio track is copied out of the
// container as-is. That needs no codec support at all; decoding to WAV is only the fallback for unusual codecs.
export async function extractAudio(file) {
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack().catch(() => null);
  if (track === null && (await input.getPrimaryVideoTrack().catch(() => null))) {
    throw new Error('Dieses Video hat keine Tonspur.');
  }
  try {
    const copied = track && await copyAudio(mb, input, track.codec);
    if (copied) return copied;
  } catch (err) {
    console.warn('Copying the audio track failed, decoding instead', err);
  }
  return { blob: (await extractWav(file)).wav, name: 'audio.wav' };
}

async function copyAudio(mb, input, codec) {
  const container = codec === 'aac' ? 'm4a' : codec === 'opus' || codec === 'vorbis' ? 'webm' : null;
  if (!container) return null;
  const target = new mb.BufferTarget();
  const format = container === 'm4a' ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
  const conversion = await mb.Conversion.init({
    input,
    output: new mb.Output({ format, target }),
    video: { discard: true },
    showWarnings: false,
  });
  if (!conversion.isValid || !conversion.utilizedTracks.some(t => t.isAudioTrack())) return null;
  await conversion.execute();
  const type = container === 'm4a' ? 'audio/mp4' : 'audio/webm';
  return { blob: new Blob([target.buffer], { type }), name: `audio.${container}` };
}

export async function extractWav(file) {
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } finally {
    ctx.close();
  }
  const mono = downmix(decoded);
  const pcm = resample(mono, decoded.sampleRate, TARGET_RATE);
  return { wav: encodeWav(pcm, TARGET_RATE), duration: decoded.duration };
}

function downmix(audio) {
  const n = audio.numberOfChannels;
  if (n === 1) return audio.getChannelData(0);
  const out = new Float32Array(audio.length);
  for (let c = 0; c < n; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / n;
  }
  return out;
}

function resample(data, from, to) {
  if (from === to) return data;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const f = pos - i0;
    out[i] = data[i0] * (1 - f) + data[i1] * f;
  }
  return out;
}

function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
