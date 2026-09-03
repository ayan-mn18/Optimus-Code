import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { estimateReadMinutes, slugify } from '../src/services/blog.service.js';

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
    for (const company of doc.companies ?? []) {
      assert.ok(company.name, `${file}: company tag without a name`);
      for (const source of company.sources ?? []) {
        assert.doesNotThrow(() => new URL(source), `${file}: bad company source ${source}`);
      }
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
