'use strict';

/**
 * Audio helpers.
 *
 * Everything downstream (Silero VAD, whisper.cpp) wants 16 kHz mono float32.
 * loopback-capture hands us 48 kHz stereo 16-bit. This module bridges that gap.
 */

/** Build a windowed-sinc lowpass FIR. cutoff is normalised to the INPUT rate. */
function makeLowpass(taps, cutoffNorm) {
  const h = new Float32Array(taps);
  const M = taps - 1;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const n = i - M / 2;
    let v;
    if (Math.abs(n) < 1e-9) {
      v = 2 * cutoffNorm;
    } else {
      v = Math.sin(2 * Math.PI * cutoffNorm * n) / (Math.PI * n);
    }
    v *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / M);
    h[i] = v;
    sum += v;
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

/**
 * Integer-factor decimator with persistent filter state.
 * Anti-alias filters before throwing samples away - skip the filter and
 * gunfire above 8 kHz folds down into the speech band as garbage.
 */
class Decimator {
  constructor(factor, taps = 63) {
    this.factor = factor;
    this.h = makeLowpass(taps, 0.95 / (2 * factor));
    this.history = new Float32Array(taps - 1);
    this.phase = 0;
  }

  process(input) {
    const h = this.h;
    const taps = h.length;
    const hist = this.history;
    const total = hist.length + input.length;

    const buf = new Float32Array(total);
    buf.set(hist, 0);
    buf.set(input, hist.length);

    const out = [];
    let i = this.phase;
    for (; i + taps <= total; i += this.factor) {
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += buf[i + k] * h[k];
      out.push(acc);
    }
    const consumed = i;
    const keep = total - consumed;
    this.history = buf.slice(total - Math.min(keep, taps - 1));
    this.phase = 0;

    return Float32Array.from(out);
  }
}

/** Interleaved float32 -> mono float32 (simple average). */
function downmixToMono(interleaved, channels) {
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += interleaved[f * channels + c];
    out[f] = acc / channels;
  }
  return out;
}

/** Raw PCM Buffer (little-endian float32) -> Float32Array. */
function bufferToFloat32(buf) {
  const n = Math.floor(buf.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/**
 * Raw PCM Buffer (little-endian signed 16-bit) -> Float32Array in [-1, 1].
 * This is what loopback-capture emits: 16-bit, stereo, 48 kHz.
 */
function bufferInt16ToFloat32(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

/** Float32Array (16 kHz mono) -> 16-bit PCM WAV Buffer. */
function encodeWav(samples, sampleRate = 16000) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);

  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, 44 + i * 2);
  }
  return buf;
}

/** Rough loudness check - used to drop segments that are almost certainly not speech. */
function rms(samples) {
  let acc = 0;
  for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
  return Math.sqrt(acc / samples.length);
}

module.exports = {
  Decimator, downmixToMono, bufferToFloat32, bufferInt16ToFloat32, encodeWav, rms,
};
