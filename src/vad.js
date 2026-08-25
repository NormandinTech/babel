'use strict';

const ort = require('onnxruntime-node');
const path = require('path');
const { rms } = require('./audio');

const WINDOW = 512;      // Silero v5 expects 512 samples @ 16 kHz
const SAMPLE_RATE = 16000;

/**
 * Silero VAD + utterance segmenter.
 *
 * Feeds 512-sample windows to the ONNX model, tracks speech/silence state,
 * and emits complete utterances. Everything downstream only ever sees
 * speech, which matters a lot: whisper hallucinates confidently on
 * non-speech input (the infamous "Thanks for watching!" on a gunfight).
 */
class Vad {
  constructor(opts = {}) {
    this.modelPath = opts.modelPath || path.join(__dirname, '..', 'models', 'silero_vad.onnx');
    this.threshold = opts.threshold ?? 0.5;
    this.minSpeechMs = opts.minSpeechMs ?? 250;
    this.hangoverMs = opts.silenceHangoverMs ?? 400;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? 12000;
    this.preRollMs = opts.preRollMs ?? 300;
    this.minRms = opts.minRms ?? 0.004;

    this.session = null;
    this.state = null;
    this.inputNames = null;

    this.pending = new Float32Array(0);   // leftover < WINDOW
    this.preRoll = [];                    // ring of recent windows
    this.preRollWindows = Math.ceil((this.preRollMs / 1000) * SAMPLE_RATE / WINDOW);

    this.inSpeech = false;
    this.current = [];
    this.silentWindows = 0;
    this.speechWindows = 0;
  }

  async init() {
    this.session = await ort.InferenceSession.create(this.modelPath);
    this.inputNames = this.session.inputNames;
    this._resetState();
  }

  _resetState() {
    // v5 uses a single combined 'state' [2,1,128]; v4 used separate h/c.
    if (this.inputNames.includes('state')) {
      this.state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
    } else {
      this.state = {
        h: new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]),
        c: new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]),
      };
    }
  }

  async _score(window) {
    const feeds = {
      input: new ort.Tensor('float32', window, [1, window.length]),
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    };

    if (this.inputNames.includes('state')) {
      feeds.state = this.state;
    } else {
      feeds.h = this.state.h;
      feeds.c = this.state.c;
    }

    const out = await this.session.run(feeds);

    if (out.stateN) this.state = out.stateN;
    else if (out.hn && out.cn) this.state = { h: out.hn, c: out.cn };

    const probTensor = out.output || out.probs || Object.values(out)[0];
    return probTensor.data[0];
  }

  /**
   * Push 16 kHz mono audio. Returns an array of completed utterances
   * (Float32Array each). Usually empty; occasionally one.
   */
  async push(samples) {
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending, 0);
    merged.set(samples, this.pending.length);

    const utterances = [];
    let off = 0;

    const hangoverWindows = Math.ceil((this.hangoverMs / 1000) * SAMPLE_RATE / WINDOW);
    const minSpeechWindows = Math.ceil((this.minSpeechMs / 1000) * SAMPLE_RATE / WINDOW);
    const maxWindows = Math.ceil((this.maxUtteranceMs / 1000) * SAMPLE_RATE / WINDOW);

    while (off + WINDOW <= merged.length) {
      const win = merged.subarray(off, off + WINDOW);
      off += WINDOW;

      const prob = await this._score(win);
      const voiced = prob >= this.threshold;

      if (!this.inSpeech) {
        this.preRoll.push(Float32Array.from(win));
        if (this.preRoll.length > this.preRollWindows) this.preRoll.shift();

        if (voiced) {
          this.inSpeech = true;
          this.current = this.preRoll.slice();
          this.preRoll = [];
          this.speechWindows = 1;
          this.silentWindows = 0;
        }
      } else {
        this.current.push(Float32Array.from(win));
        if (voiced) {
          this.speechWindows++;
          this.silentWindows = 0;
        } else {
          this.silentWindows++;
        }

        const tooLong = this.current.length >= maxWindows;
        const ended = this.silentWindows >= hangoverWindows;

        if (ended || tooLong) {
          if (this.speechWindows >= minSpeechWindows) {
            const utt = this._flatten(this.current);
            if (rms(utt) >= this.minRms) utterances.push(utt);
          }
          this.inSpeech = false;
          this.current = [];
          this.speechWindows = 0;
          this.silentWindows = 0;
        }
      }
    }

    this.pending = merged.slice(off);
    return utterances;
  }

  _flatten(windows) {
    let total = 0;
    for (const w of windows) total += w.length;
    const out = new Float32Array(total);
    let o = 0;
    for (const w of windows) { out.set(w, o); o += w.length; }
    return out;
  }
}

module.exports = { Vad, WINDOW, SAMPLE_RATE };
