# Babel

Real-time voice translation for game voice chat. Runs entirely on your machine. No account, no API key, no paywall.

You hear teammates in your language. They hear you in theirs. Nothing is drawn on screen.

---

## How it works

```
GAME AUDIO  --> per-process loopback --> VAD --> whisper --> translate --> Piper --> your headphones
YOUR MIC    --> ffmpeg dshow         --> VAD --> whisper --> translate --> Piper --> VB-CABLE --> game mic
```

The game process is never touched. Audio is read through a Windows OS API
(`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) — no injection, no memory reads, no overlay
hooking. Nothing here is the kind of thing anti-cheat looks for.

---

## What you need

**Hardware:** an NVIDIA GPU makes this usable. CPU-only works but adds 1–2 seconds.
**Headphones are required.** On speakers, the translated audio feeds back into your mic and loops.

### Getting the binaries

Drop these into `bin\` and `models\`:

| File | Where | Notes |
|---|---|---|
| `whisper-cli.exe` + DLLs | `bin\` | whisper.cpp release, **CUDA build**. Older releases call it `main.exe` — rename it. |
| `ggml-small.bin` | `models\` | whisper.cpp model. Start with `small`; try `medium` if accuracy is rough. |
| `silero_vad.onnx` | `models\` | From the snakers4/silero-vad repo. |
| `piper.exe` + DLLs | `bin\` | Piper release for Windows x64. |
| `*.onnx` + `*.onnx.json` voices | `models\` | One per target language. |
| `ffmpeg.exe`, `ffplay.exe` | `bin\` | Any Windows FFmpeg build. |
| `llama-server.exe` + a GGUF | `bin\`, `models\` | Only if you want non-English targets. |

### VB-CABLE (outgoing only)

Windows has no built-in virtual microphone, and shipping one means a signed kernel driver.
So: install VB-CABLE (free), then in the game set **microphone input = `CABLE Output`**.

Your real voice no longer reaches teammates — only the translation does. That is intended.

---

## Setup

```
setup.bat
npm run devices        REM copy your mic name
npm run processes      REM with the game running, copy the title
```

Edit `config.json`, then:

```
run.bat
```

---

## config.json, briefly

- `incoming.processName` — substring of the game window title, or a raw PID
- `incoming.targetLanguage` — what **you** want to hear
- `outgoing.targetLanguage` — what **they** hear
- `outgoing.playbackDevice` — must be `CABLE Input (VB-Audio Virtual Cable)`
- `translate.backend` — `whisper` is free and fast but **English output only**. Use `llama` for anything else.

### Tuning the VAD

If it triggers on gunfire, raise `vad.threshold` toward `0.7`.
If it clips the start of words, raise `vad.preRollMs`.
If it cuts people off mid-sentence, raise `vad.silenceHangoverMs`.

---

## Expected latency

Roughly 1.2–2.5s from end-of-speech to audio, on a modern NVIDIA card with `small`.
The timing breakdown prints on every line so you can see which stage is the problem.

Realistically: fine for "there's a guy in the red building," too slow for "grenade."

---

## Known limits

- **Windows 10 build 2004+ only.** Per-process loopback doesn't exist before that.
- **In-game VOIP arrives mixed with game audio.** Works, but noisier than Discord. If the game
  offers a separate voice-chat output device, use it and point Babel at that device instead.
- **Exclusive-mode audio blocks loopback.** Uncheck exclusive mode in Windows sound settings.
- **Whisper hallucinates on noise.** VAD plus a filter list catches most of it; some gets through.
- **Overlapping speakers get mangled.** No diarisation. Two people talking at once produces one garbled line.

---

## Roadmap

- [ ] Push-to-talk for the outgoing direction (`node-global-key-listener`)
- [ ] DeepFilterNet or RNNoise pass before VAD, for in-game VOIP
- [ ] Kokoro-82M as a TTS option (better quality, needs a Python sidecar)
- [ ] Optional captions on `localhost` for a second monitor or phone
- [ ] Portable build so it's one unzip for someone you just met

---

## License

MIT. Model and binary licenses are separate — whisper.cpp is MIT, Piper's active fork is
GPL-3.0, Silero VAD is MIT. Check them before you do anything commercial with this.
