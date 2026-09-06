/**
 * Re-runs research on already-written blogs and merges any NEW evidence in.
 *
 * Deliberately does not recompose the article — the prose stays exactly as it
 * is. This only widens the provenance footer, which is the half that improves
 * as more of the web becomes reachable.
 *
 *   node scripts/reharvest.js [--only <slug>] [--limit N]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvest } from '../src/services/research/pipeline.js';
import { extractEvidence } from '../src/services/research/extract.js';
import { checkProvenance } from '../src/services/research/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'data', 'blogs');

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const files = (await fs.readdir(dir))
  .filter((f) => f.endsWith('.json'))
  .filter((f) => (flag('only') ? f === `${flag('only')}.json` : true))
  .slice(0, Number(flag('limit', 99)));

let totalNew = 0;

for (const file of files) {
  const target = path.join(dir, file);
  const doc = JSON.parse(await fs.readFile(target, 'utf8'));
  const before = doc.evidence?.length ?? 0;
  console.log(`\n── ${doc.slug}  (${before} sources)`);

  let pages;
  try {
    pages = await harvest(
      { title: doc.title, kind: doc.kind, topic: doc.topic },
      { onProgress: (m) => console.log(`   ${m}`) },
    );
  } catch (error) {
    console.log(`   ✗ harvest failed: ${error.message}`);
    continue;
  }

  const known = new Set((doc.evidence ?? []).map((e) => e.url));
  const fresh = pages.filter((p) => p.ok && !known.has(p.url));
  console.log(`   ${pages.filter((p) => p.ok).length} readable, ${fresh.length} not already cited`);

  const found = [];
  for (const page of fresh) {
    const hit = await extractEvidence(page, doc.title).catch(() => null);
    if (hit) found.push(hit);
  }

  const { evidence, dropped } = checkProvenance(found);
  if (dropped.length) console.log(`   ${dropped.length} claim(s) failed the quote check`);

  if (!evidence.length) { console.log('   no new verified evidence'); continue; }

  doc.evidence = [...(doc.evidence ?? []), ...evidence];
  await fs.writeFile(target, JSON.stringify(doc, null, 2));
  totalNew += evidence.length;

  for (const item of evidence) {
    console.log(`   + ${item.kind.padEnd(9)} ${item.source} — ${item.companies.map((c) => c.name).join(', ')}`);
  }
  console.log(`   ${before} → ${doc.evidence.length} sources`);
}

console.log(`\ndone — ${totalNew} new verified source(s) across ${files.length} article(s)`);
process.exit(0);
