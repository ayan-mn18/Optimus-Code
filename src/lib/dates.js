/**
 * All day boundaries are computed in the user's own timezone so that "today"
 * means the same thing to the user and to the challenge engine.
 */

/** Current calendar date in `timezone`, as YYYY-MM-DD. */
export function todayIn(timezone = 'UTC') {
  return formatDate(new Date(), timezone);
}

/** Formats an instant as YYYY-MM-DD in `timezone`. */
export function formatDate(date, timezone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
}

export function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Shifts a YYYY-MM-DD string by `days`, staying in plain-date space. */
export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const stamp = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(stamp).toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a, b) {
  const toUtc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}
