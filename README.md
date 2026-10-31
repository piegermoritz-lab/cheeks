# tricaps

Captions app for my videos, built for the iPhone. Speech in Swiss German becomes High German captions burned into the video.

**Flow:** pick a video → automatic transcription → fix words → export → save to Photos.

## Setup

1. Get a free API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Open https://tricaps.vercel.app in Safari on the iPhone, tap Share → "Add to Home Screen".
3. In the app, open ⚙︎ and paste the key. It is stored only on the phone.

## How it works

- `js/audio.js` decodes the video's audio on the phone and shrinks it to 16 kHz mono WAV, which keeps the upload small.
- `js/transcribe.js` sends the audio to Groq (`whisper-large-v3`, language `de`) and gets word timestamps back. ß is always replaced by ss.
- `js/dictionary.js` holds the default dictionary (names, places, triathlon terms, Swiss German slips). Terms are sent to Whisper as spelling hints; `wrong = right` lines are replaced after transcription. Edit it in that file.
- `js/captions.js` groups the words into captions and holds the caption style (`defaultStyle`).
- `js/hdr.js` converts HDR footage (iPhone HLG, also PQ) to SDR BT.709 on the GPU following BT.2408, from the raw decoded YUV where the browser allows it. Used for export and editor still frames, so iPhone HDR clips don't come out washed out.
- `js/render-fast.js` decodes, captions and re-encodes with WebCodecs (H.264, 30 fps, ~20 Mbit/s at 1080p); audio is copied.
- `js/render.js` is the fallback: it plays the video once in real time and records the captioned canvas with MediaRecorder.

No build step: it's plain HTML/CSS/JS. Vercel deploys every push automatically.

## Local test

```sh
npx http-server -p 8765
```
