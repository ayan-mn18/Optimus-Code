import { judge0 as defaultTransport } from './judge0.js';
import {
  buildSubmissions, getLanguage, newMarker, parseMarkerOutput, prepareTests, normaliseResultSet,
} from './index.js';

/**
 * Runs one answer and says which tests passed.
 *
 * `includeHidden` is the whole security model of the Run button: a program built
 * for a practice run physically does not contain the hidden tests, so no amount
 * of printing from inside the student's own code can reveal them.
 */
export async function runAnswer({
  question,
  languageId,
  source,
  includeHidden = false,
  transport = defaultTransport,
}) {
  getLanguage(languageId);   // rejects an unsupported language before we build anything
  const tests = prepareTests(question, { includeHidden });
  if (!tests.length) throw new Error('Question has no tests to run');

  const marker = newMarker();
  const submissions = buildSubmissions({ question, languageId, source, tests, marker });

  const outcomes = [];
  let stderr = '';
  let compileOutput = '';
  let status = 'Accepted';
  let time = null;
  let memory = null;

  for (const submission of submissions) {
    const result = await transport.execute(submission.judge0);
    stderr = stderr || result.stderr;
    compileOutput = compileOutput || result.compileOutput;
    time = time ?? result.time;
    memory = memory ?? result.memory;
    if (result.status?.description && result.status.description !== 'Accepted') {
      status = result.status.description;
    }

    if (submission.mode === 'stdout') {
      const expected = normaliseResultSet(submission.expected, question);
      const actual = normaliseResultSet(result.stdout, question);
      outcomes.push({
        name: submission.test.name,
        visible: submission.test.visible,
        passed: expected === actual && !result.stderr,
        expected,
        actual,
        ...(result.stderr ? { error: result.stderr.slice(0, 300) } : {}),
      });
      continue;
    }

    const parsed = parseMarkerOutput(result.stdout, marker, submission.tests);
    if (!parsed) {
      // No result line: the program never reached the harness. Compile errors,
      // a crash at import time, or a timeout all land here.
      const reason = compileOutput?.trim() || result.message || result.stderr?.trim()
        || `${result.status?.description ?? 'Run failed'}`;
      for (const test of submission.tests) {
        outcomes.push({ name: test.name, visible: test.visible, passed: false, error: reason.slice(0, 400) });
      }
      continue;
    }

    parsed.forEach((entry, index) => {
      outcomes.push({ ...entry, visible: submission.tests[index].visible });
    });
  }

  const passedCount = outcomes.filter((outcome) => outcome.passed).length;
  return {
    passed: passedCount === outcomes.length,
    passedCount,
    total: outcomes.length,
    ratio: outcomes.length ? passedCount / outcomes.length : 0,
    results: outcomes,
    status,
    stderr: (stderr || '').slice(0, 4000),
    compileOutput: (compileOutput || '').slice(0, 4000),
    time,
    memory,
  };
}

/**
 * What a student is allowed to see. A hidden test keeps its name — knowing that
 * "concurrent eviction" failed is a fair hint — but never its data.
 */
export function redactResults(results) {
  return results.map((result) => (result.visible
    ? result
    : { name: result.name, visible: false, passed: result.passed }));
}
