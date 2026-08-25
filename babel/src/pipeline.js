'use strict';

const { Vad } = require('./vad');
const { looksLikeHallucination } = require('./stt');

/**
 * One direction of translation, end to end.
 *
 * capture -> VAD -> whisper -> translate -> piper -> playback device
 *
 * Utterances are processed serially per direction. That's deliberate: two
 * whisper runs racing on the same GPU is slower than doing them in order,
 * and out-of-order speech is worse than late speech.
 */
class Direction {
  constructor({ name, capture, vadCfg, stt, translator, tts, player, targetLanguage, playbackDevice, log }) {
    this.name = name;
    this.capture = capture;
    this.stt = stt;
    this.translator = translator;
    this.tts = tts;
    this.player = player;
    this.targetLanguage = targetLanguage;
    this.playbackDevice = playbackDevice;
    this.log = log;

    this.vad = new Vad(vadCfg);
    this.queue = Promise.resolve();
    this.busy = 0;
    this.maxQueue = 3;
  }

  async start() {
    await this.vad.init();

    this.capture.on('info', msg => this.log.info(`[${this.name}] ${msg}`));
    this.capture.on('error', err => this.log.warn(`[${this.name}] ${err.message}`));

    this.capture.on('audio', (samples) => {
      this.vad.push(samples)
        .then(utterances => {
          for (const utt of utterances) this._enqueue(utt);
        })
        .catch(err => this.log.warn(`[${this.name}] vad: ${err.message}`));
    });

    await this.capture.start();
    this.log.info(`[${this.name}] listening -> ${this.targetLanguage}`);
  }

  _enqueue(utterance) {
    // Under load, drop the oldest rather than build an ever-growing backlog.
    // A callout delivered 15 seconds late is noise.
    if (this.busy >= this.maxQueue) {
      this.log.warn(`[${this.name}] backlog full, dropping utterance`);
      return;
    }
    this.busy++;
    this.queue = this.queue
      .then(() => this._process(utterance))
      .catch(err => this.log.warn(`[${this.name}] ${err.message}`))
      .finally(() => { this.busy--; });
  }

  async _process(utterance) {
    const t0 = Date.now();
    const durationMs = Math.round((utterance.length / 16000) * 1000);

    // When the target is English, let whisper do the translation in one pass.
    const oneShot = this.targetLanguage === 'en' && this.translator.backend === 'whisper';

    const { text, language } = await this.stt.transcribe(utterance, { toEnglish: oneShot });
    const tStt = Date.now();

    if (!text || looksLikeHallucination(text)) {
      this.log.debug(`[${this.name}] discarded: "${text}"`);
      return;
    }

    const translated = oneShot
      ? text
      : await this.translator.translate(text, this.targetLanguage, language);

    if (!translated) return;
    const tMt = Date.now();

    if (!this.tts.hasVoice(this.targetLanguage)) {
      this.log.warn(`[${this.name}] no voice for '${this.targetLanguage}' — text only: ${translated}`);
      return;
    }

    const wav = await this.tts.speak(translated, this.targetLanguage);
    const tTts = Date.now();

    this.log.line(
      `[${this.name}] ${language} -> ${this.targetLanguage}` +
      `  "${text}"  =>  "${translated}"` +
      `  (${durationMs}ms speech | stt ${tStt - t0} mt ${tMt - tStt} tts ${tTts - tMt} = ${tTts - t0}ms)`
    );

    await this.player.play(wav, this.playbackDevice);
  }

  stop() {
    try { this.capture.stop(); } catch (_) {}
  }
}

module.exports = { Direction };
