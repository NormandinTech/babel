'use strict';

const path = require('path');
const { rms } = require('./audio');

const WINDOW = 512;        // chunk size Silero expects at 16 kHz
const CONTEXT = 64;        // samples carried over from the previous chunk
const SAMPLE_RATE = 16000;

/**
 * Silero VAD + utterance segmenter.
 *
 * IMPORTANT: Silero v5 does not take a bare 512-sample window. Its reference
 * implementation prepends 64 samples of context from the previous chunk, so
 * the model actually receives 576 samples. The ONNX input dimension is
 * dynamic, so feeding it a plain 512 raises no error - it just returns
 * ~0.001 for everything, including obvious speech. Measured on real audio:
 * plain 512 gave max prob 0.0034; 576-with-context gave 1.0000.
 *
 * onnxruntime is loaded lazily inside init() so the diagnostic commands work
 * on a bare checkout with nothing installed.
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

    this.ort = null;
    this.session = null;
    this.state = null;
    this.inputNames = null;

    this.context = new Float32Array(CONTEXT);
    this.pending = new Float32Array(0);
    this.preRoll = [];
    this.preRollWindows = Math.ceil((this.preRollMs / 1000) * SAMPLE_RATE / WINDOW);

    this.inSpeech = false;
    this.current = [];
    this.silentWindows = 0;
    this.speechWindows = 0;
    this.peakProb = 0;
  }

  async init() {
    this.ort = require('onnxruntime-node');
    this.session = await this.ort.InferenceSession.create(this.modelPath);
    this.inputNames = this.session.inputNames;
    this._resetState();
  }

  _resetState() {
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
  }

  async _score(window) {
    // Build the 576-sample input: 64 samples of context + this 512 chunk.
    const input = new Float32Array(CONTEXT + WINDOW);
    input.set(this.context, 0);
    input.set(window, CONTEXT);

    const out = await this.session.run({
      input: new this.ort.Tensor('float32', input, [1, CONTEXT + WINDOW]),
      state: this.state,
      sr: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    });

    if (out.stateN) this.state = out.stateN;

    // Carry the tail of this chunk forward as the next chunk's context.
    this.context = Float32Array.from(window.subarray(WINDOW - CONTEXT));

    return out.output.data[0];
  }

  /**
   * Push 16 kHz mono audio. Returns completed utterances (Float32Array each).
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
      if (prob > this.peakProb) this.peakProb = prob;
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

module.exports = { Vad, WINDOW, CONTEXT, SAMPLE_RATE };
