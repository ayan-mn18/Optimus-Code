import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { getOrSetCached } from '../../lib/cache.js';

/**
 * Judge0 transport.
 *
 * We run on the free public instance, which owes us nothing: no SLA, and limits
 * that can tighten without notice. Three habits keep us welcome there and make
 * the eventual move to a paid or self-hosted endpoint a change of two
 * environment variables:
 *
 *   - a global concurrency cap, so a class all pressing Run does not arrive as
 *     a burst;
 *   - retry with backoff on 429 and 5xx, because a queued judge is not a broken
 *     one;
 *   - a short dedupe cache, because students press Run on unchanged code far
 *     more often than they edit it.
 */

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEDUPE_TTL_MS = 10 * 60_000;
const LANGUAGES_TTL_MS = 60 * 60_000;

/**
 * Judge0 language ids are per-instance, not universal.
 *
 * The public CE tracks recent runtimes — Python 3.12 is 100, Node 22 is 102 —
 * while a self-hosted 1.13.1 has neither and tops out at Python 3.8 (71) and
 * Node 12 (63). Sending 100 to that box is a 422 on every coding submission,
 * which is exactly what happened. So the ids we prefer are a list, and the
 * transport picks the newest one the instance in front of it actually has.
 */
const LANGUAGE_FALLBACKS = {
  100: [100, 71],   // Python 3.12 → 3.8
  102: [102, 63],   // Node 22 → Node 12
};

const encode = (text) => Buffer.from(text ?? '', 'utf8').toString('base64');
const decode = (text) => Buffer.from(text ?? '', 'base64').toString('utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal fixed-width gate. Nothing fancier is warranted for one process. */
function createGate(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async function through(task) {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export function createJudge0({ config = env.runner, fetchImpl = fetch } = {}) {
  const gate = createGate(config.concurrency ?? 4);

  /** What this instance can actually run. Asked once an hour, not per submission. */
  async function supportedLanguages() {
    return getOrSetCached(`judge0:languages:${config.baseUrl}`, LANGUAGES_TTL_MS, async () => {
      try {
        const headers = {};
        if (config.apiKey) headers[config.authHeader ?? 'x-rapidapi-key'] = config.apiKey;
        if (config.apiHost) headers['x-rapidapi-host'] = config.apiHost;
        const response = await fetchImpl(`${config.baseUrl}/languages`, { headers });
        if (!response.ok) return null;
        const languages = await response.json();
        return new Set(languages.map((language) => language.id));
      } catch {
        // An instance that will not list its languages still gets the request
        // we would otherwise have sent; this is an optimisation, not a gate.
        return null;
      }
    });
  }

  async function resolveLanguageId(wanted) {
    const candidates = LANGUAGE_FALLBACKS[wanted];
    if (!candidates) return wanted;
    const supported = await supportedLanguages();
    if (!supported) return wanted;
    return candidates.find((candidate) => supported.has(candidate)) ?? wanted;
  }

  async function post(body) {
    const headers = { 'content-type': 'application/json' };
    // RapidAPI and Sulu authenticate with these; a self-hosted box uses X-Auth-Token.
    if (config.apiKey) headers[config.authHeader ?? 'x-rapidapi-key'] = config.apiKey;
    if (config.apiHost) headers['x-rapidapi-host'] = config.apiHost;

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
      try {
        const response = await fetchImpl(
          `${config.baseUrl}/submissions?base64_encoded=true&wait=true`,
          { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal },
        );
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload;
        if (!RETRYABLE.has(response.status)) {
          throw new ApiError(502, payload.message ?? `Code runner rejected the submission (${response.status})`);
        }
        lastError = new ApiError(503, 'The code runner is busy. Try again in a moment.');
      } catch (error) {
        if (error instanceof ApiError && error.status === 502) throw error;
        lastError = error?.name === 'AbortError'
          ? new ApiError(504, 'The code runner timed out')
          : error;
      } finally {
        clearTimeout(timer);
      }
      await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 200));
    }
    throw lastError instanceof ApiError ? lastError : new ApiError(503, 'The code runner is unavailable');
  }

  return {
    get configured() {
      return Boolean(config.enabled && config.baseUrl);
    },

    /**
     * @param {object} judge0 language_id plus either source_code or additional_files, unencoded
     * @returns {Promise<{stdout: string, stderr: string, compileOutput: string, status: object, time: ?string, memory: ?number}>}
     */
    async execute(judge0) {
      if (!config.enabled || !config.baseUrl) throw new ApiError(503, 'Code runner is not configured');

      const body = {
        ...judge0,
        // Resolved before the cache key is built, so the key describes the
        // submission that is actually sent.
        language_id: await resolveLanguageId(judge0.language_id),
        ...(judge0.source_code !== undefined ? { source_code: encode(judge0.source_code) } : {}),
        cpu_time_limit: config.cpuTimeLimit ?? 5,
        wall_time_limit: config.wallTimeLimit ?? 12,
        memory_limit: config.memoryLimit ?? 256_000,
        enable_network: false,
      };
      const key = `judge0:${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;

      return getOrSetCached(key, DEDUPE_TTL_MS, async () => {
        const payload = await gate(() => post(body));
        return {
          stdout: decode(payload.stdout),
          stderr: decode(payload.stderr),
          compileOutput: decode(payload.compile_output),
          message: payload.message ?? null,
          status: payload.status ?? { id: 0, description: 'Unknown' },
          time: payload.time ?? null,
          memory: payload.memory ?? null,
        };
      });
    },
  };
}

export const judge0 = createJudge0();
