/**
 * The gates. All mechanical — no model checks another model's work here.
 *
 * Provenance is first because it is the one that cannot be argued with: a quote
 * either appears in the page we fetched or it does not, and String.includes
 * settles it for free.
 */

const BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'list', 'callout', 'code',
  'mermaid', 'table', 'steps', 'quote', 'widget', 'divider',
]);

const KNOWN_WIDGETS = new Set(['file-system-trie']);

/** Whitespace is the only thing we forgive — markdown reflows it constantly. */
const normalise = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Gate 1: every company quote is a literal span of the page it came from. */
export function checkProvenance(evidence) {
  const kept = [];
  const dropped = [];

  for (const item of evidence) {
    const haystack = normalise(item._pageText);
    const companies = (item.companies ?? []).filter((company) => {
      const quote = normalise(company.quote);
      const ok = quote.length >= 12 && haystack.includes(quote);
      if (!ok) dropped.push(`${item.url} :: ${company.name}`);
      return ok;
    });

    if (companies.length) {
      const clean = { ...item };
      delete clean._pageText;      // page text is a validation input, not output
      kept.push({ ...clean, companies });
    }
  }
  return { evidence: kept, dropped };
}

export function checkBlocks(blocks) {
  const problems = [];
  if (!Array.isArray(blocks) || !blocks.length) return ['no blocks'];

  blocks.forEach((block, index) => {
    if (!block?.type) problems.push(`block ${index}: missing type`);
    else if (!BLOCK_TYPES.has(block.type)) problems.push(`block ${index}: unknown type ${block.type}`);
    if (block?.type === 'heading' && ![2, 3].includes(block.level)) problems.push(`block ${index}: bad heading level`);
    if (block?.type === 'table' && !Array.isArray(block.headers)) problems.push(`block ${index}: table without headers`);
  });
  return problems;
}

/** Widgets the reader cannot draw are stripped rather than shipped blank. */
export function stripUnknownWidgets(blocks) {
  const removed = [];
  const kept = blocks.filter((block) => {
    if (block.type !== 'widget') return true;
    if (KNOWN_WIDGETS.has(block.name)) return true;
    removed.push(block.name);
    return false;
  });
  return { blocks: kept, removed };
}

export function checkSubstance(blocks, { template }) {
  const problems = [];
  const words = blocks
    .flatMap((block) => Object.values(block).filter((value) => typeof value === 'string'))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;

  if (blocks.length < 18) problems.push(`only ${blocks.length} blocks`);
  if (words < 900) problems.push(`only ${words} words`);
  if (!blocks.some((block) => block.type === 'mermaid')) problems.push('no diagram');
  if (template === 'problem' && !blocks.some((block) => block.type === 'code')) problems.push('no code block');
  return problems;
}

/** Gate: no 25-word run shared with any harvested page. The copyright gate. */
export function checkOriginality(blocks, pages, { run = 25 } = {}) {
  const prose = normalise(
    blocks.flatMap((b) => Object.values(b).filter((v) => typeof v === 'string')).join(' '),
  ).split(' ');

  const sources = pages.map((page) => normalise(page.text));

  for (let i = 0; i + run <= prose.length; i += 1) {
    const window = prose.slice(i, i + run).join(' ');
    if (sources.some((source) => source.includes(window))) {
      return [`copies ${run} consecutive words from a source: "${window.slice(0, 80)}…"`];
    }
  }
  return [];
}

/** Every ref must answer. LeetCode 403s bots, so a 403 counts as reachable. */
export async function checkLinks(refs, { fetchImpl = fetch } = {}) {
  const kept = [];
  const dropped = [];

  for (const ref of refs) {
    let ok = false;
    for (const method of ['HEAD', 'GET']) {
      try {
        const response = await fetchImpl(ref.url, {
          method,
          redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0' },
        });
        if (response.ok || response.status === 403) { ok = true; break; }
      } catch {
        // try the next method
      }
    }
    (ok ? kept : dropped).push(ref);
  }
  return { refs: kept, dropped };
}
