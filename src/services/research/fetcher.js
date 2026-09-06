import { env } from '../../config/env.js';

/**
 * The scraping ladder.
 *
 * Three rungs, cheapest first, and we only climb when the rung below actually
 * fails. Running everything through a cloud browser would multiply the bill by
 * an order of magnitude for no extra evidence.
 *
 *   1. plain fetch   free        static HTML — GeeksforGeeks, most blogs
 *   2. Firecrawl     per page    JS rendering, markdown out — LeetCode, Blind
 *   3. Browser Use   per minute  a real driven browser — hosts Firecrawl refuses
 *
 * Firecrawl declines some hosts by policy rather than by capability (Reddit
 * answers "we do not support this site"), which is the only reason rung 3
 * exists at all.
 */

const MIN_USEFUL_CHARS = 400;
const HOST_DELAY_MS = 1000;

const lastHit = new Map();

/** One request per second per host, so we are a good citizen by construction. */
async function politeDelay(url) {
  const host = safeHost(url);
  const wait = (lastHit.get(host) ?? 0) + HOST_DELAY_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastHit.set(host, Date.now());
}

export function safeHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Strips tags and collapses whitespace. Good enough for static pages. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Rung 1 — plain fetch                                                        */
/* -------------------------------------------------------------------------- */

async function viaDirect(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'OptimusCodeResearch/1.0 (+https://optimuscode.dev)' },
    redirect: 'follow',
  });
  if (!response.ok) return { ok: false, reason: `http ${response.status}` };

  const text = htmlToText(await response.text());
  return text.length >= MIN_USEFUL_CHARS
    ? { ok: true, rung: 'direct', text }
    : { ok: false, reason: `only ${text.length} chars` };
}

/* -------------------------------------------------------------------------- */
/* Rung 2 — Firecrawl                                                          */
/* -------------------------------------------------------------------------- */

async function viaFirecrawl(url, fetchImpl) {
  if (!env.research.firecrawlKey) return { ok: false, reason: 'firecrawl not configured' };

  const response = await fetchImpl(`${env.research.firecrawlUrl}/scrape`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.research.firecrawlKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) {
    // 403 here usually means Firecrawl declines the host on policy, not that
    // the page is unreachable — that distinction is what triggers rung 3.
    return {
      ok: false,
      reason: payload?.error ?? `http ${response.status}`,
      refusedHost: response.status === 403,
    };
  }

  const text = (payload.data?.markdown ?? '').trim();
  return text.length >= MIN_USEFUL_CHARS
    ? { ok: true, rung: 'firecrawl', text }
    : { ok: false, reason: `only ${text.length} chars` };
}

/* -------------------------------------------------------------------------- */
/* Rung 3 — Browser Use                                                        */
/* -------------------------------------------------------------------------- */

async function viaBrowserUse(url, fetchImpl) {
  if (!env.research.browserUseKey) return { ok: false, reason: 'browser use not configured' };

  const start = await fetchImpl(`${env.research.browserUseUrl}/tasks`, {
    method: 'POST',
    headers: {
      'X-Browser-Use-API-Key': env.research.browserUseKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      task: `Open ${url} and return the full visible article text verbatim. Do not summarise, do not add commentary.`,
      allowedDomains: [safeHost(url)],
    }),
  });

  const started = await start.json().catch(() => ({}));
  if (!start.ok) {
    // 402 is the common one: the account has no credits.
    return { ok: false, reason: started?.detail ?? `http ${start.status}` };
  }

  const id = started.id ?? started.taskId;
  if (!id) return { ok: false, reason: 'no task id returned' };

  // Poll until the task settles or we run out of patience.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const poll = await fetchImpl(`${env.research.browserUseUrl}/tasks/${id}`, {
      headers: { 'X-Browser-Use-API-Key': env.research.browserUseKey },
    });
    const state = await poll.json().catch(() => ({}));
    if (['finished', 'completed', 'success'].includes(state.status)) {
      const text = (state.output ?? state.result ?? '').trim();
      return text.length >= MIN_USEFUL_CHARS
        ? { ok: true, rung: 'browser-use', text }
        : { ok: false, reason: `only ${text.length} chars` };
    }
    if (['failed', 'stopped', 'error'].includes(state.status)) {
      return { ok: false, reason: state.status };
    }
  }
  return { ok: false, reason: 'timed out' };
}

/* -------------------------------------------------------------------------- */

/**
 * Fetches one page, climbing the ladder only as far as it has to.
 * Always resolves — a page we cannot read is data, not an exception.
 */
export async function fetchPage(url, { fetchImpl = fetch } = {}) {
  await politeDelay(url);
  const attempts = [];

  for (const [name, rung] of [['direct', viaDirect], ['firecrawl', viaFirecrawl], ['browser-use', viaBrowserUse]]) {
    let result;
    try {
      result = await rung(url, fetchImpl);
    } catch (error) {
      result = { ok: false, reason: error.message };
    }

    attempts.push({ rung: name, ok: result.ok, reason: result.reason });
    if (result.ok) return { ok: true, url, host: safeHost(url), rung: name, text: result.text, attempts };

    // Only escalate past Firecrawl when it declined the host itself. If it
    // read the page and there was simply nothing there, a browser will not help.
    if (name === 'firecrawl' && !result.refusedHost && !/not configured/.test(result.reason ?? '')) break;
  }

  return { ok: false, url, host: safeHost(url), text: '', attempts };
}

/** Firecrawl also does search, which is why there is no separate search vendor. */
export async function search(query, { limit = 6, fetchImpl = fetch } = {}) {
  if (!env.research.firecrawlKey) return [];

  const response = await fetchImpl(`${env.research.firecrawlUrl}/search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.research.firecrawlKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, limit }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.success) return [];

  const rows = Array.isArray(payload.data) ? payload.data : payload.data?.web ?? [];
  return rows
    .filter((row) => row?.url)
    .map((row) => ({ title: row.title ?? '', url: row.url, snippet: row.description ?? '' }));
}
