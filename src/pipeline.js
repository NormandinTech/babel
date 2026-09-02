'use strict';

const { Vad } = require('./vad');
const { looksLikeHallucination } = require('./stt');

/**
 * One direction of translation, end to end.
 *
 *   capture -> VAD -> detect language -> whisper -> translate -> piper -> playback
 *
 * The language-detection step exists to avoid work: most speech in your lobby
 * is already in your language, and a full decode of it is wasted time that
 * pushes the queue behind. Detection exits early and is much cheaper.
 */
class Direction {
  constructor({ name, capture, vadCfg, stt, translator, tts, player,
                targetLanguage, playbackDevice, log, speakSameLanguage = false,
                repeatWindowMs = 45000, maxAgeMs = 8000 }) {
    this.name = name;
    this.capture = capture;
    this.stt = stt;
    this.translator = translator;
    this.tts = tts;
    this.player = player;
    this.targetLanguage = targetLanguage;
    this.playbackDevice = playbackDevice;
    this.log = log;

    this.speakSameLanguage = speakSameLanguage;
    this.repeatWindowMs = repeatWindowMs;
    this.maxAgeMs = maxAgeMs;

    this.vad = new Vad(vadCfg);
    this.queue = Promise.resolve();
    this.busy = 0;
    this.maxQueue = 2;
    this.spoken = new Map();
    this.paused = false;
    this.onCaption = null;
  }

  async start() {
    await this.vad.init();
    this.capture.on('info', msg => this.log.info(`[${this.name}] ${msg}`));
    this.capture.on('error', err => this.log.warn(`[${this.name}] ${err.message}`));

    this.capture.on('audio', (samples) => {
      this.vad.push(samples)
        .then(us => { for (const u of us) this._enqueue(u); })
        .catch(err => this.log.warn(`[${this.name}] vad: ${err.message}`));
    });

    await this.capture.start();
    this.log.info(`[${this.name}] listening -> ${this.targetLanguage}`);
  }

  _enqueue(utterance) {
    if (this.paused) return;
    if (this.busy >= this.maxQueue) {
      this.log.debug(`[${this.name}] busy, dropping utterance`);
      return;
    }
    this.busy++;
    const capturedAt = Date.now();
    this.queue = this.queue
      .then(() => this._process(utterance, capturedAt))
      .catch(err => this.log.warn(`[${this.name}] ${err.message}`))
      .finally(() => { this.busy--; });
  }

  /** Time-based, so an A/B/A/B loop can't slip through a position-based window. */
  _isRepeat(text) {
    const key = text.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
    const now = Date.now();
    for (const [k, t] of this.spoken) {
      if (now - t > this.repeatWindowMs) this.spoken.delete(k);
    }
    if (this.spoken.has(key)) {
      this.spoken.set(key, now);      // refresh so a loop stays suppressed
      return true;
    }
    this.spoken.set(key, now);
    return false;
  }

  async _process(utterance, capturedAt) {
    const age = Date.now() - capturedAt;
    if (age > this.maxAgeMs) {
      this.log.debug(`[${this.name}] stale, dropped (${age}ms behind)`);
      return;
    }

    const t0 = Date.now();
    const durationMs = Math.round((utterance.length / 16000) * 1000);

    // Cheap language check first. If they're already speaking your language,
    // skip the expensive decode entirely.
    let detected = null;
    if (!this.speakSameLanguage) {
      detected = await this.stt.detectLanguage(utterance);
      if (detected && detected === this.targetLanguage) {
        this.log.debug(`[${this.name}] ${detected} (already yours), skipped`);
        return;
      }
    }
    const tDetect = Date.now();

    const useWhisperTranslate =
      this.targetLanguage === 'en' && this.translator.backend === 'whisper';

    const { text, language } = await this.stt.transcribe(utterance, {
      toEnglish: useWhisperTranslate,
      language: detected || 'auto',
    });
    const tStt = Date.now();

    if (!text) return;
    if (looksLikeHallucination(text)) {
      this.log.debug(`[${this.name}] filtered: "${text}"`);
      return;
    }
    if (this._isRepeat(text)) {
      this.log.debug(`[${this.name}] repeat suppressed: "${text}"`);
      return;
    }

    const srcLang = detected || language;
    let translated;
    try {
      translated = useWhisperTranslate || srcLang === this.targetLanguage
        ? text
        : await this.translator.translate(text, this.targetLanguage, srcLang);
    } catch (err) {
      // Show what was heard even when translation dies - otherwise a broken
      // translate stage is indistinguishable from a broken capture stage.
      this.log.warn(`[${this.name}] heard "${text}" but translation failed: ${err.message}`);
      return;
    }
    if (!translated) return;
    const tMt = Date.now();

    if (!this.tts.hasVoice(this.targetLanguage)) {
      this.log.warn(`[${this.name}] no voice for '${this.targetLanguage}': ${translated}`);
      return;
    }

    const wav = await this.tts.speak(translated, this.targetLanguage);
    const tTts = Date.now();

    this.log.line(
      `[${this.name}] ${srcLang}->${this.targetLanguage}  "${translated}"` +
      `  (${durationMs}ms | det ${tDetect - t0} stt ${tStt - tDetect} ` +
      `mt ${tMt - tStt} tts ${tTts - tMt})`
    );

    if (this.onCaption) {
      this.onCaption({ from: srcLang, text: translated });
    }

    await this.player.play(wav, this.playbackDevice);
  }

  setTarget(lang) {
    this.targetLanguage = lang;
    this.spoken.clear();
  }

  stop() {
    try { this.capture.stop(); } catch (_) {}
  }
}

module.exports = { Direction };
