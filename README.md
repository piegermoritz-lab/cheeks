# Cheeks

Captions app for my videos, built for the iPhone. Speech in Swiss German becomes High German captions burned into the video.

**Flow:** pick a video → automatic transcription → fix words → export → save to Photos.

## Setup

1. Get a free API key at [console.groq.com/keys](https://console.groq.com/keys).
2. Open the app in Safari on the iPhone, tap Share → "Add to Home Screen".
3. In the app, open ⚙︎ and paste the key. It is stored only on the phone.

## How it works

- `js/audio.js` decodes the video's audio on the phone and shrinks it to 16 kHz mono WAV, which keeps the upload small.
- `js/transcribe.js` sends the audio to Groq (`whisper-large-v3`, language `de`) and gets word timestamps back. ß is always replaced by ss.
- `js/captions.js` groups the words into captions and holds the caption style (`defaultStyle`).
- `js/render.js` plays the video once in real time, draws each frame plus captions onto a canvas and records it with MediaRecorder. The export therefore takes as long as the video.

No build step: it's plain HTML/CSS/JS, hosted on GitHub Pages.

## Local test

```sh
npx http-server -p 8765
```
