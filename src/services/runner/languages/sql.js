/**
 * SQL answers are graded by running the query against seed data and diffing the
 * result set, so each seed set is its own submission — there is no in-process
 * harness to loop for us. Dialect is SQLite, because that is what Judge0 ships.
 */

const PREAMBLE = '.headers off\n.mode list\n.separator |\n.nullvalue NULL\n';

export const sql = {
  id: 'sql',
  label: 'SQL',
  monaco: 'sql',
  judge0Id: 82,
  packaging: 'single',
  // A grader answer is one query. Anything that writes is either cheating
  // (rewriting the seed data until the query is right) or a mistake.
  denylist: [
    /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace)\b/i,
    /\.(read|shell|system|import|output)\b/i,
  ],

  denyMessage: (found) => `Answer with a single SELECT — \`${found}\` changes the data instead of querying it.`,

  starter: () => '-- Write a single SELECT statement.\nSELECT\n',

  /** One submission per seed set. */
  buildSubmissions({ question, source, tests }) {
    return tests.map((test) => ({
      test,
      mode: 'stdout',
      expected: test.expectedStdout,
      judge0: {
        language_id: sql.judge0Id,
        source_code: `${PREAMBLE}${question.schema}\n${test.seed}\n${stripTrailingSemicolon(source)};\n`,
      },
    }));
  },
};

const stripTrailingSemicolon = (text) => text.trim().replace(/;+\s*$/, '');

/**
 * Whitespace and row order are presentation, not answers — unless the question
 * asked for an order, in which case order is the whole point.
 */
export function normaliseResultSet(stdout, { orderMatters }) {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0);
  return (orderMatters ? lines : [...lines].sort()).join('\n');
}
