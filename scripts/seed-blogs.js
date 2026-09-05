/**
 * Seeds editorial blogs from data/blogs/*.json.
 * Idempotent — re-running upserts on slug and keeps views, likes and the
 * original published_at.
 *
 *   npm run seed:blogs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, unwrap } from '../src/lib/supabase.js';
import { companiesFromEvidence, estimateReadMinutes } from '../src/services/blog.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const blogDir = path.join(here, '..', 'data', 'blogs');

const files = (await fs.readdir(blogDir)).filter((file) => file.endsWith('.json'));
console.log(`seeding ${files.length} blog(s)`);

for (const file of files) {
  const doc = JSON.parse(await fs.readFile(path.join(blogDir, file), 'utf8'));

  // Editorial blogs are pinned to a catalogue problem by slug so the System
  // Design list can deep-link to them without hard-coded ids.
  let problemId = null;
  if (doc.problemSlug) {
    const problem = unwrap(
      await db.from('problems').select('id').eq('slug', doc.problemSlug).maybeSingle(),
      'look up linked problem',
    );
    if (!problem) console.warn(`  ! no problem with slug "${doc.problemSlug}" — leaving unlinked`);
    problemId = problem?.id ?? null;
  }

  const existing = unwrap(
    await db.from('blogs').select('id, published_at').eq('slug', doc.slug).maybeSingle(),
    'look up existing blog',
  );

  const row = {
    slug: doc.slug,
    title: doc.title,
    summary: doc.summary ?? null,
    kind: doc.kind ?? 'LLD',
    problem_id: problemId,
    topic: doc.topic ?? null,
    difficulty: doc.difficulty ?? null,
    author_id: null,
    author_name: doc.authorName ?? 'Optimus Code',
    origin: doc.origin ?? 'editorial',
    status: doc.status ?? 'published',
    cover_emoji: doc.coverEmoji ?? '📘',
    read_minutes: estimateReadMinutes(doc.blocks ?? []),
    blocks: doc.blocks ?? [],
    tags: doc.tags ?? [],
    evidence: doc.evidence ?? [],
    // Derived, never authored — see companiesFromEvidence.
    companies: companiesFromEvidence(doc.evidence ?? []),
    refs: doc.refs ?? [],
    published_at: existing?.published_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  unwrap(await db.from('blogs').upsert(row, { onConflict: 'slug' }), 'upsert blog');
  console.log(
    `  ✓ ${doc.slug} — ${row.blocks.length} blocks, ~${row.read_minutes} min, `
    + `${row.evidence.length} sources → ${row.companies.length} companies`,
  );
}

console.log('done');
process.exit(0);
