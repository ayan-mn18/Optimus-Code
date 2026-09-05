import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { companiesFromEvidence, estimateReadMinutes, slugify } from '../src/services/blog.service.js';

test('slugs are url-safe, collapsed and bounded', () => {
  assert.equal(slugify('Design File System'), 'design-file-system');
  assert.equal(slugify('  LRU  Cache — Design!! '), 'lru-cache-design');
  assert.equal(slugify('***'), 'untitled');
  assert.ok(slugify('a'.repeat(200)).length <= 80);
});

test('read time counts prose inside every renderable block type', () => {
  const words = (count) => Array.from({ length: count }, () => 'word').join(' ');
  assert.equal(estimateReadMinutes([]), 1);
  assert.equal(estimateReadMinutes([{ type: 'paragraph', text: words(400) }]), 2);
  // Titles inside steps, callouts and tables are prose too — a blog that is
  // mostly tables must not report a one-minute read.
  assert.equal(
    estimateReadMinutes([
      { type: 'steps', items: [{ title: words(200), text: words(200) }] },
      { type: 'table', headers: [words(100)], rows: [[words(100)]] },
      { type: 'callout', title: words(100), text: words(100) },
    ]),
    4,
  );
  // A block type the reader does not know yet contributes nothing rather than
  // throwing — the pipeline is allowed to run ahead of the UI.
  assert.equal(estimateReadMinutes([{ type: 'future-widget', payload: { text: words(1000) } }]), 1);
});

test('seeded blogs are well formed and every reference is a real url', async () => {
  const dir = new URL('../data/blogs/', import.meta.url);
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
  assert.ok(files.length > 0, 'expected at least one seeded blog');

  for (const file of files) {
    const doc = JSON.parse(await fs.readFile(new URL(file, dir), 'utf8'));
    assert.equal(doc.slug, slugify(doc.slug), `${file}: slug is not canonical`);
    assert.ok(doc.title && doc.summary, `${file}: needs a title and summary`);
    assert.ok(['DSA', 'LLD', 'HLD', 'General'].includes(doc.kind), `${file}: bad kind`);
    assert.ok(doc.blocks.length > 5, `${file}: too thin to publish`);

    for (const block of doc.blocks) {
      assert.ok(typeof block.type === 'string' && block.type, `${file}: block without a type`);
    }
    for (const ref of doc.refs ?? []) {
      assert.ok(ref.title, `${file}: reference without a title`);
      assert.doesNotThrow(() => new URL(ref.url), `${file}: bad reference url ${ref.url}`);
    }
    assert.ok(!doc.companies, `${file}: companies are derived from evidence, not authored`);
    for (const item of doc.evidence ?? []) {
      assert.doesNotThrow(() => new URL(item.url), `${file}: bad evidence url ${item.url}`);
      assert.ok(item.title, `${file}: evidence without a title`);
      assert.ok(['report', 'aggregate', 'roundup'].includes(item.kind), `${file}: bad evidence kind`);
      assert.ok(item.companies?.length, `${file}: evidence naming no company`);
      for (const mention of item.companies) {
        assert.ok(mention.name, `${file}: company mention without a name`);
      }
    }

    // The bug this replaced: seven company cards all linking to the same URL.
    const derived = companiesFromEvidence(doc.evidence ?? []);
    for (const company of derived) {
      assert.ok(company.sources.length, `${file}: ${company.name} has no source`);
      assert.equal(
        new Set(company.sources).size,
        company.sources.length,
        `${file}: ${company.name} lists the same source twice`,
      );
    }
  }
});

test('blog tables and counters behave under the canonical schema', async () => {
  const database = new PGlite();
  await database.exec('create role anon; create role authenticated; create role service_role;');
  const source = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await database.exec(source.replace('create extension if not exists "pgcrypto";', ''));

  const { rows: [user] } = await database.query(
    "insert into users (email, name) values ('reader@example.com', 'Reader') returning id",
  );
  const { rows: [blog] } = await database.query(
    `insert into blogs (slug, title, kind, status, published_at)
     values ('design-file-system', 'Design File System', 'LLD', 'published', now())
     returning id, views, likes`,
  );
  assert.equal(blog.views, 0);

  const { rows: [viewed] } = await database.query("select increment_blog_views('design-file-system') as views");
  assert.equal(viewed.views, 1);

  // A draft must not accrue reads.
  await database.query(
    "insert into blogs (slug, title, kind, status) values ('draft-post', 'Draft', 'LLD', 'draft')",
  );
  const { rows: [draft] } = await database.query("select increment_blog_views('draft-post') as views");
  assert.equal(draft.views, null, 'a draft must not accrue reads');

  const liked = await database.query('select * from toggle_blog_like($1, $2)', [blog.id, user.id]);
  assert.deepEqual(liked.rows[0], { liked: true, likes: 1 });
  const unliked = await database.query('select * from toggle_blog_like($1, $2)', [blog.id, user.id]);
  assert.deepEqual(unliked.rows[0], { liked: false, likes: 0 });

  await database.close();
});

test('company tags roll up per source, and cannot outrun their evidence', () => {
  const evidence = [
    {
      url: 'https://example.com/reports',
      kind: 'aggregate',
      companies: [{ name: 'Google' }, { name: 'Capital One', role: 'Senior', date: 'Jun 2026' }],
    },
    {
      url: 'https://example.com/write-up',
      kind: 'report',
      companies: [{ name: 'Google', role: 'L4', date: 'May 2024' }],
    },
    // Same source listed twice must not inflate the count.
    { url: 'https://example.com/write-up', kind: 'report', companies: [{ name: 'Google' }] },
    // A source with no companies, and a company with no name, contribute nothing.
    { url: 'https://example.com/empty', kind: 'roundup', companies: [] },
  ];

  const [google, capitalOne] = companiesFromEvidence(evidence);

  assert.equal(google.name, 'Google');
  assert.equal(google.count, 2, 'count is distinct sources, not mentions');
  assert.deepEqual(google.sources, ['https://example.com/reports', 'https://example.com/write-up']);
  assert.deepEqual(google.roles, ['L4']);
  assert.equal(google.confidence, 'reported', 'a company inherits its strongest evidence');
  assert.equal(google.lastSeen, 'May 2024');

  assert.equal(capitalOne.confidence, 'aggregated');
  assert.equal(capitalOne.lastSeen, 'Jun 2026');

  // No evidence, no tag — there is no other way to get one.
  assert.deepEqual(companiesFromEvidence([]), []);
  assert.deepEqual(companiesFromEvidence([{ kind: 'report', companies: [{ name: 'Ghost' }] }]), []);
});
