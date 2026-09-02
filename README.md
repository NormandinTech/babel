# Babel

Real-time voice translation for game voice chat. Runs entirely on your machine.
No account, no API key, no paywall, nothing drawn on screen.

You hear other players in your language. Confirmed working in DayZ.

---

## How it works

```
GAME AUDIO --> WASAPI loopback --> VAD --> language check --> whisper --> Piper --> your headphones
YOUR MIC   --> ffmpeg dshow    --> VAD --> whisper --> translate --> Piper --> VB-CABLE --> game mic
```

The game process is never touched. Audio is read through a Windows OS API - no
injection, no memory reads, no overlay hooking.

---

## Zero configuration

Out of the box, with nothing edited:

- **Any game.** It captures all desktop audio, so it doesn't know or care what
  you're running. DayZ, CoD, Discord, a browser - same behaviour.
- **Any incoming language.** Whisper detects it per utterance. There is no
  source-language setting to get wrong.
- **Your language.** `targetLanguage` is blank by default, which means "use
  whatever this computer is set to." A German player gets German if the voice is
  installed, English otherwise, with a note saying which file to download.

Everything below is for people who want to change that.

## Setup

1. Install Node.js from nodejs.org
2. Put the binaries in place (see below)
3. Double-click `run.bat`

### Binaries

| File | Goes in | Source |
|---|---|---|
| `whisper-cli.exe` + CUDA DLLs | `bin\` | whisper.cpp releases, **cublas** build |
| `ggml-small.bin` | `models\` | HuggingFace ggerganov/whisper.cpp |
| `silero_vad.onnx` | `models\` | snakers4/silero-vad |
| `piper.exe` + `espeak-ng-data` | `bin\piper\` | rhasspy/piper 2023.11.14-2 |
| voice `.onnx` + `.onnx.json` | `models\` | rhasspy/piper-voices |
| `ffmpeg.exe`, `ffplay.exe` | `bin\` | gyan.dev builds |

`get-deps.ps1` fetches most of these automatically.

### Windows settings that matter

- **Turn off exclusive mode.** `mmsys.cpl` > Playback > your device > Advanced >
  uncheck "Allow applications to take exclusive control." Games grab the device
  otherwise and loopback captures silence.
- **Check your mic level.** `mmsys.cpl` > Recording > Levels. A mic at -46 dB is
  below the VAD floor and nothing will ever trigger.
- Headphones required. On speakers the output feeds back into the input.

---

## Tuning

Everything lives in `config.json`.

| Symptom | Fix |
|---|---|
| Triggers on gunfire | raise `vad.threshold` toward 0.85 |
| Misses quiet speech | lower `vad.threshold`, or raise the Windows mic level |
| Clips the first word | raise `vad.preRollMs` |
| Cuts people off | raise `vad.silenceHangoverMs` |
| Repeats a phrase forever | it's a hallucination; add it to `HALLUCINATIONS` in `src/stt.js` |
| Slow (`stt` over 2000 ms) | GPU isn't engaged - `whisper.extraArgs` must be `[]` |
| Wrong words on names/slang | switch to `ggml-medium.bin` |

`logLevel: "debug"` shows filtered and skipped utterances.

---

## Two things that will waste your evening if you don't know them

**Silero VAD needs 576 samples, not 512.** It takes a 512-sample chunk plus 64
samples of context carried from the previous chunk. The ONNX input dimension is
dynamic, so feeding a bare 512 raises no error - it just returns ~0.001 for
everything, including obvious speech. Measured here: plain 512 gave max
probability 0.0034 on clear speech; 576-with-context gave 1.0000.

**whisper.cpp falls back to CPU silently.** No warning, just 7 seconds per
utterance instead of 500 ms. Babel now says which one it's using at startup.

---

## Known limits

- Windows 10 build 2004+ only
- In-game VOIP arrives mixed with gunfire; noisier than Discord
- Whisper hallucinates on music and ambient noise; filtered but not perfectly
- No diarisation - two people talking at once produces one garbled line
- Non-English output needs llama-server running on :8080

## Roadmap

- [ ] Push-to-talk for the outgoing direction
- [ ] DeepFilterNet before the VAD, for gunfire
- [ ] Portable build - one unzip, no Node install

## License

MIT. Bundled binaries keep their own licenses: whisper.cpp MIT, Silero MIT,
Piper 2023.11 MIT, ffmpeg GPL.
