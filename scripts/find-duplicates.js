/**
 * Finds near-duplicate write-ups.
 *
 * The catalogue itself carries overlapping entries — "Locks and Types of
 * Locks" and "Types of Locks", "Design Cache" and an LRU cache article — so
 * the pipeline faithfully produces two articles about one thing. This reports
 * the pairs; which of each to keep is an editorial call, not a mechanical one.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'blogs');

/** Bag-of-words overlap, ignoring the words every title shares. */
const STOP = new Set(['design', 'a', 'an', 'the', 'of', 'and', 'to', 'in', 'system', 'systems', 'lld', 'hld', 'introduction']);
const terms = (title) => new Set(
  title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)),
);

function jaccard(a, b) {
  const overlap = [...a].filter((w) => b.has(w)).length;
  const union = new Set([...a, ...b]).size;
  return union ? overlap / union : 0;
}

const docs = [];
for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.json'))) {
  const doc = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
  docs.push({
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    blocks: doc.blocks.length,
    evidence: doc.evidence?.length ?? 0,
    origin: doc.origin,
    terms: terms(doc.title),
  });
}

const pairs = [];
for (let i = 0; i < docs.length; i += 1) {
  for (let j = i + 1; j < docs.length; j += 1) {
    const score = jaccard(docs[i].terms, docs[j].terms);
    if (score >= 0.6) pairs.push({ score, a: docs[i], b: docs[j] });
  }
}
pairs.sort((x, y) => y.score - x.score);

console.log(`${docs.length} articles, ${pairs.length} near-duplicate pair(s)\n`);
for (const { score, a, b } of pairs) {
  // The richer article is usually the one to keep: more evidence, then more blocks.
  const keep = (a.evidence - b.evidence) || (a.blocks - b.blocks) >= 0 ? a : b;
  console.log(`  ${(score * 100).toFixed(0)}%  ${a.kind}`);
  console.log(`     ${a.slug}  (${a.blocks} blocks, ${a.evidence} sources, ${a.origin})`);
  console.log(`     ${b.slug}  (${b.blocks} blocks, ${b.evidence} sources, ${b.origin})`);
  console.log(`     -> suggest keeping ${keep.slug}\n`);
}
process.exit(0);
