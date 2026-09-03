/**
 * Seeds DSA plus System Design catalogues.
 * Idempotent — re-running upserts on (kind, slug).
 *
 *   npm run seed
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, unwrap } from '../src/lib/supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dsaFile = path.join(here, '..', 'data', 'problems.json');
const systemDesignFile = path.join(here, '..', 'data', 'system-design.json');

const dsaProblems = JSON.parse(await fs.readFile(dsaFile, 'utf8')).map((problem) => ({
  ...problem,
  kind: 'DSA',
  assessment_enabled: false,
  coding_enabled: false,
  resource_metadata: {},
}));
const systemDesignProblems = JSON.parse(await fs.readFile(systemDesignFile, 'utf8'));
const problems = [...dsaProblems, ...systemDesignProblems];
console.log(`seeding ${problems.length} problems across DSA, LLD, and HLD`);

const CHUNK = 50;
for (let i = 0; i < problems.length; i += CHUNK) {
  const chunk = problems.slice(i, i + CHUNK);
  unwrap(await db.from('problems').upsert(chunk, { onConflict: 'kind,slug' }), 'upsert problems');
  console.log(`  ${Math.min(i + CHUNK, problems.length)}/${problems.length}`);
}

const counts = Object.fromEntries(['DSA', 'LLD', 'HLD'].map((kind) => [kind, problems.filter((p) => p.kind === kind).length]));
console.log(`done — ${JSON.stringify(counts)}`);
process.exit(0);
