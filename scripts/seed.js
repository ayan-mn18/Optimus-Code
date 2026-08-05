/**
 * Seeds the problem catalogue scraped from the Striver SDE Sheet.
 * Idempotent — re-running upserts on `slug`.
 *
 *   npm run seed
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, unwrap } from '../src/lib/supabase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = path.join(here, '..', 'data', 'problems.json');

const problems = JSON.parse(await fs.readFile(dataFile, 'utf8'));
console.log(`seeding ${problems.length} problems from ${path.relative(process.cwd(), dataFile)}`);

const CHUNK = 50;
for (let i = 0; i < problems.length; i += CHUNK) {
  const chunk = problems.slice(i, i + CHUNK);
  unwrap(await db.from('problems').upsert(chunk, { onConflict: 'slug' }), 'upsert problems');
  console.log(`  ${Math.min(i + CHUNK, problems.length)}/${problems.length}`);
}

const topics = [...new Set(problems.map((p) => p.topic))];
console.log(`done — ${topics.length} topics: ${topics.join(', ')}`);
process.exit(0);
