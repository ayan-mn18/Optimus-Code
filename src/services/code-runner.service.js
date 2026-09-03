import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

const NODE_LANGUAGE_ID = 63;
const MAX_SOURCE_BYTES = 50_000;

function harness(source, tests) {
  return `'use strict';\n${source}\n\nconst __tests = ${JSON.stringify(tests)};\nconst __results = [];\nfor (const test of __tests) {\n  try {\n    const actual = selectNext(test.input);\n    const passed = JSON.stringify(actual) === JSON.stringify(test.expected);\n    __results.push({ name: test.name, passed, expected: test.expected, actual });\n  } catch (error) {\n    __results.push({ name: test.name, passed: false, expected: test.expected, error: String(error?.message ?? error) });\n  }\n}\nconsole.log('__OPTIMUS_RESULT__' + JSON.stringify(__results));`;
}

export function createCodeRunner({ config = env.runner, fetchImpl = fetch } = {}) {
  return {
    configured: Boolean(config.enabled && config.baseUrl),

    async run({ source, tests }) {
      if (!config.enabled || !config.baseUrl) throw new ApiError(503, 'Code runner is not configured');
      if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) throw ApiError.badRequest('Code exceeds 50 KB');
      if (!Array.isArray(tests) || !tests.length || tests.length > 25) throw ApiError.badRequest('Invalid test suite');

      const headers = { 'content-type': 'application/json' };
      if (config.apiKey) headers['x-rapidapi-key'] = config.apiKey;
      if (config.apiHost) headers['x-rapidapi-host'] = config.apiHost;

      const response = await fetchImpl(`${config.baseUrl}/submissions?base64_encoded=true&wait=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          language_id: NODE_LANGUAGE_ID,
          source_code: Buffer.from(harness(source, tests)).toString('base64'),
          cpu_time_limit: 2,
          memory_limit: 128000,
          max_file_size: 1024,
          enable_network: false,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(502, payload.message ?? 'Code runner rejected the submission');

      const stdout = Buffer.from(payload.stdout ?? '', 'base64').toString('utf8');
      const stderr = Buffer.from(payload.stderr ?? '', 'base64').toString('utf8');
      const compileOutput = Buffer.from(payload.compile_output ?? '', 'base64').toString('utf8');
      const marker = stdout.split('\n').find((line) => line.startsWith('__OPTIMUS_RESULT__'));
      let results = [];
      if (marker) {
        try { results = JSON.parse(marker.slice('__OPTIMUS_RESULT__'.length)); } catch { results = []; }
      }

      const passed = results.length === tests.length && results.every((result) => result.passed);
      return {
        passed,
        results,
        status: payload.status?.description ?? 'Unknown',
        stderr: (stderr || compileOutput).slice(0, 4000),
        time: payload.time ?? null,
        memory: payload.memory ?? null,
      };
    },
  };
}

export const codeRunner = createCodeRunner();
