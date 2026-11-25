// Short device report for the loaded video, to debug exports on phones we can't test on.
export async function diagnose(file, video) {
  const lines = [];
  const log = (k, v) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  log('ua', navigator.userAgent.replace(/^Mozilla\/5\.0 /, ''));
  const mb = await import('./vendor/mediabunny-1.64.0.min.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) return 'keine Videospur';
  const at = await input.getPrimaryAudioTrack();
  log('video', { codec: await vt.getCodecParameterString(), ...(await vt.getColorSpace()), hdr: await vt.hasHighDynamicRange(), rot: vt.rotation, w: vt.displayWidth, h: vt.displayHeight, decode: await vt.canDecode() });
  log('audio', at ? { codec: at.codec, ch: at.numberOfChannels, rate: at.sampleRate } : 'none');
  log('encode', { avc: await mb.canEncodeVideo('avc'), vp9: await mb.canEncodeVideo('vp9'), rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype });

  if (video?.readyState >= 2) {
    const W = 90;
    const H = Math.round((W * video.videoHeight) / video.videoWidth);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, W, H);
    const pts = [[0.5, 0.5], [0.25, 0.2], [0.75, 0.2], [0.25, 0.8], [0.75, 0.8]];
    log('video pixels', pts.map(([x, y]) => [...ctx.getImageData(Math.floor(x * W), Math.floor(y * H), 1, 1).data].slice(0, 3).join('/')).join(' '));
  } else {
    log('video pixels', `not loaded (readyState ${video?.readyState})`);
  }
  return lines.join('\n');
}
