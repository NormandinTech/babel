'use strict';

/**
 * Translation stage.
 *
 * Two backends:
 *   'whisper' — no-op here; whisper already produced English via -tr.
 *               Free, fastest, but English target only.
 *   'llama'   — POSTs to a local llama-server OpenAI-compatible endpoint.
 *               Any language pair, and it handles callouts and slang far
 *               better than a straight MT model ("push B" stays a command,
 *               not a sentence about shoving).
 */

const LANG_NAMES = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', ru: 'Russian',
  de: 'German', fr: 'French', it: 'Italian', pl: 'Polish',
  tr: 'Turkish', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese',
  ko: 'Korean', nl: 'Dutch', sv: 'Swedish', uk: 'Ukrainian',
};

const SYSTEM_PROMPT = (target) => `You translate live voice chat from multiplayer games into ${LANG_NAMES[target] || target}.

Rules:
- Output ONLY the translation. No quotes, no notes, no explanation.
- Keep it short and spoken. This gets read aloud in a firefight.
- Preserve gaming callouts as callouts. Map to the equivalent term players actually use in the target language rather than translating word by word.
- Keep numbers, compass directions, and map/place names intact.
- Profanity stays profanity. Do not soften it.
- If the input is not intelligible speech, output exactly: [unclear]`;

class Translator {
  constructor(cfg) {
    this.backend = cfg.backend || 'whisper';
    this.endpoint = cfg.endpoint;
    this.model = cfg.model || 'local';
    this.timeoutMs = cfg.timeoutMs || 4000;
  }

  /**
   * @param {string} text     source text
   * @param {string} target   target language code
   * @param {string} sourceLang  detected source (may be 'unknown')
   * @returns {Promise<string|null>} null = drop this utterance
   */
  async translate(text, target, sourceLang = 'unknown') {
    if (!text || !text.trim()) return null;

    // Already in the target language — nothing to do.
    if (sourceLang && sourceLang !== 'unknown' && sourceLang === target) return text;

    if (this.backend === 'whisper') {
      // whisper -tr already produced English. Anything else isn't supported here.
      if (target !== 'en') {
        throw new Error(
          `translate.backend is 'whisper', which only outputs English. ` +
          `Target '${target}' needs backend 'llama'.`
        );
      }
      return text;
    }

    return await this._llama(text, target);
  }

  async _llama(text, target) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          max_tokens: 160,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT(target) },
            { role: 'user', content: text },
          ],
        }),
      });

      if (!res.ok) throw new Error(`llama-server ${res.status}`);
      const json = await res.json();
      const out = (json.choices?.[0]?.message?.content || '').trim();

      if (!out || out === '[unclear]') return null;
      // Strip any wrapping quotes the model adds despite instructions.
      return out.replace(/^["'`]+|["'`]+$/g, '').trim();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`translation timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { Translator, LANG_NAMES };
