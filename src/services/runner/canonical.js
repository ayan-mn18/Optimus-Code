/**
 * One definition of "these two values are the same answer", for every language.
 *
 * A question is written once and answered in Python, JavaScript, Java or C++, so the
 * grader cannot compare native values — a Java `HashMap` and a Python `dict`
 * are the same answer and share no representation. Instead every harness
 * renders its result to a canonical string using the rules below, and compares
 * that against a string this module produced when the paper was assembled.
 *
 * The rules, which every harness must reproduce exactly:
 *   null/None            -> null
 *   true/false           -> true / false
 *   integral numbers     -> the integer, no decimal point, no exponent
 *   other numbers        -> six decimal places, trailing zeroes trimmed
 *   strings              -> JSON-quoted
 *   lists                -> [a,b,c], order preserved
 *   maps                 -> {"k":v,...}, keys sorted, so iteration order cannot matter
 *
 * Six decimals is the tolerance: it is coarse enough that the same arithmetic
 * done in float64 and in Java `double` agrees, and fine enough that a wrong
 * answer never rounds into a right one.
 */

const DECIMALS = 6;

export function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  // Nothing else is expressible in the question schema's type vocabulary.
  return JSON.stringify(String(value));
}

export function canonicalNumber(value) {
  if (!Number.isFinite(value)) return 'null';
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(DECIMALS);
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  // -0.0000001 must not canonicalise to "-0".
  return trimmed === '-0' ? '0' : trimmed;
}
