import crypto from 'node:crypto';
import { ApiError } from '../../lib/errors.js';
import { canonical } from './canonical.js';
import { zipBase64 } from './zip.js';
import { python } from './languages/python.js';
import { javascript } from './languages/javascript.js';
import { java } from './languages/java.js';
import { sql, normaliseResultSet } from './languages/sql.js';

export const LANGUAGES = { python, javascript, java, sql };
/** Launch set. Adding C++/Go/TypeScript is a new module and an entry here. */
export const CODE_LANGUAGES = ['python', 'javascript', 'java'];
export const DEFAULT_LANGUAGE = 'python';

const MAX_SOURCE_BYTES = 50_000;

export function getLanguage(id) {
  const language = LANGUAGES[id];
  if (!language) throw ApiError.badRequest(`Unsupported language: ${id}`);
  return language;
}

export const languageChoices = () => CODE_LANGUAGES.map((id) => ({
  id,
  label: LANGUAGES[id].label,
  monaco: LANGUAGES[id].monaco,
}));

/**
 * A per-submission nonce, so a student cannot fake the result line.
 *
 * Their code runs before the harness and shares its stdout, so `print("<marker>...")`
 * would otherwise report a perfect score. They cannot suppress the harness's own
 * line, so any run carrying two marker lines is a forgery and is rejected outright.
 */
export const newMarker = () => `__OPTIMUS_${crypto.randomBytes(9).toString('hex').toUpperCase()}__`;

export function guardSource(language, source) {
  if (typeof source !== 'string' || !source.trim()) throw ApiError.badRequest('Write some code first');
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) throw ApiError.badRequest('Code exceeds 50 KB');
  for (const pattern of language.denylist) {
    const match = pattern.exec(source);
    if (match) throw ApiError.badRequest(language.denyMessage(match[0].trim()));
  }
  return source;
}

/**
 * Stored tests keep their expectations as real JSON values; harnesses compare
 * canonical strings. Converting here means every language receives the same
 * expectation text and none of them has to agree on how to render the *expected*
 * side — only on how to render the actual one.
 */
export function prepareTests(question, { includeHidden }) {
  return (question.tests ?? [])
    .filter((test) => includeHidden || test.visible)
    .map((test) => ({
      name: test.name,
      visible: Boolean(test.visible),
      ...(test.seed !== undefined ? { seed: test.seed, expectedStdout: test.expectedStdout } : {}),
      steps: (test.steps ?? []).map((step) => ({
        op: step.op,
        args: step.args ?? [],
        ...(step.throws ? { throws: true } : {}),
        ...(Object.hasOwn(step, 'expect') && !step.throws ? { expect: canonical(step.expect) } : {}),
      })),
    }));
}

/**
 * Turns a question plus an answer into the Judge0 submissions that grade it.
 * Code languages get one submission holding every test; SQL gets one per seed set.
 */
export function buildSubmissions({ question, languageId, source, tests, marker }) {
  const language = getLanguage(languageId);
  guardSource(language, source);

  if (language.id === 'sql') return language.buildSubmissions({ question, source, tests });

  const built = language.buildProgram({ entity: question.entity, tests, source, marker });
  const judge0 = built.files
    ? { language_id: language.judge0Id, additional_files: zipBase64(built.files) }
    : { language_id: language.judge0Id, source_code: built.source };

  return [{ mode: 'marker', tests, judge0 }];
}

/** Pulls the harness's result line out of stdout, refusing forgeries. */
export function parseMarkerOutput(stdout, marker, tests) {
  const lines = String(stdout ?? '').split('\n').filter((line) => line.includes(marker));
  if (lines.length === 0) return null;
  if (lines.length > 1) {
    throw ApiError.badRequest('This submission printed the grader\'s own result line. Remove it and submit your solution.');
  }
  const json = lines[0].slice(lines[0].indexOf(marker) + marker.length);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== tests.length) return null;
  return parsed;
}

export { normaliseResultSet };
