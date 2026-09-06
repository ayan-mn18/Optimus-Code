import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { candidateSlugs } from '../src/services/research/resolve.js';
import {
  checkBlocks, checkOriginality, checkProvenance,
  checkSubstance, stripUnknownWidgets,
} from '../src/services/research/validate.js';
import { fetchPage, search, safeHost } from '../src/services/research/fetcher.js';

test('a company claim survives only if its quote is literally in the page', () => {
  const page = 'Round 2. The interviewer asked me to implement a thread-safe LRU cache with put and get.';
  const { evidence, dropped } = checkProvenance([{
    url: 'https://example.com/x',
    companies: [
      { name: 'Real', quote: 'implement a thread-safe LRU cache' },
      { name: 'Paraphrased', quote: 'asked me to build a threadsafe LRU' },
      { name: 'Invented', quote: 'this was asked at Initech in 2031' },
      { name: 'TooShort', quote: 'LRU' },
    ],
    _pageText: page,
  }]);

  assert.deepEqual(evidence[0].companies.map((c) => c.name), ['Real']);
  assert.equal(dropped.length, 3, 'paraphrase, invention and a too-short span are all rejected');
  assert.ok(!('_pageText' in evidence[0]), 'page text is a validation input, never published');
});

test('a source whose every claim fails leaves no evidence behind', () => {
  const { evidence } = checkProvenance([
    { url: 'u', companies: [{ name: 'Ghost', quote: 'never appeared anywhere' }], _pageText: 'unrelated text' },
  ]);
  assert.deepEqual(evidence, []);
});

test('whitespace differences are forgiven, wording differences are not', () => {
  const { evidence } = checkProvenance([{
    url: 'u',
    companies: [{ name: 'Ok', quote: 'design   an\n elevator system' }],
    _pageText: 'Round 1. Design an elevator system. Then we discussed scheduling.',
  }]);
  assert.equal(evidence[0].companies.length, 1, 'markdown reflows whitespace, so only that is normalised');
});

test('block validation rejects types the reader cannot draw', () => {
  assert.deepEqual(checkBlocks([]), ['no blocks']);
  assert.deepEqual(checkBlocks([{ type: 'paragraph', text: 'x' }]), []);
  assert.ok(checkBlocks([{ type: 'carousel' }])[0].includes('unknown type'));
  assert.ok(checkBlocks([{ type: 'heading', level: 1, text: 'x' }])[0].includes('bad heading level'));
});

test('unknown widgets are stripped rather than shipped blank', () => {
  const { blocks, removed } = stripUnknownWidgets([
    { type: 'widget', name: 'file-system-trie' },
    { type: 'widget', name: 'not-built-yet' },
    { type: 'paragraph', text: 'kept' },
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(removed, ['not-built-yet']);
});

test('substance gate demands a diagram, and code only for problems', () => {
  const thin = [{ type: 'paragraph', text: 'short' }];
  assert.ok(checkSubstance(thin, { template: 'problem' }).includes('no diagram'));
  assert.ok(checkSubstance(thin, { template: 'problem' }).includes('no code block'));
  assert.ok(!checkSubstance(thin, { template: 'concept' }).includes('no code block'));
});

test('originality gate catches a copied run and ignores an ordinary overlap', () => {
  const source = [{ text: 'the interviewer asked me to implement a thread safe cache with get and put methods today' }];
  const copied = [{ type: 'paragraph', text: 'the interviewer asked me to implement a thread safe cache with get and put methods today' }];
  const original = [{ type: 'paragraph', text: 'a cache keyed by recency needs a doubly linked list' }];

  assert.equal(checkOriginality(copied, source, { run: 10 }).length, 1);
  assert.equal(checkOriginality(original, source, { run: 10 }).length, 0);
});

test('leetcode slug candidates cover the common title shapes', () => {
  const slugs = candidateSlugs('Design an ATM Machine');
  assert.ok(slugs.includes('design-an-atm-machine'));
  assert.ok(slugs.includes('design-atm-machine'));
  assert.ok(candidateSlugs('Design Tic Tac Toe Game').includes('design-tic-tac-toe'));
});

test('the ladder climbs only when a rung fails, and stops when one succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => `<p>${'word '.repeat(200)}</p>` };
  };
  const page = await fetchPage('https://example.com/a', { fetchImpl });

  assert.equal(page.ok, true);
  assert.equal(page.rung, 'direct', 'a readable static page never reaches Firecrawl');
  assert.equal(page.attempts.length, 1);
  assert.equal(calls.length, 1, 'no paid call was made');
});

test('a page too thin to be useful is a failure, not an exception', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<p>tiny</p>' });
  const page = await fetchPage('https://example.com/b', { fetchImpl });
  assert.equal(page.ok, false);
  assert.equal(page.text, '');
  assert.ok(page.attempts[0].reason.includes('chars'));
});

test('search returns nothing rather than throwing when unconfigured', async () => {
  assert.deepEqual(await search('anything', { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), []);
});

test('safeHost strips www and survives junk', () => {
  assert.equal(safeHost('https://www.geeksforgeeks.org/x'), 'geeksforgeeks.org');
  assert.equal(safeHost('not a url'), 'not a url');
});

test('research jobs table applies and constrains its status', async () => {
  const database = new PGlite();
  await database.exec('create role anon; create role authenticated; create role service_role;');
  const source = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await database.exec(source.replace('create extension if not exists "pgcrypto";', ''));

  const { rows } = await database.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='blog_research_jobs'`);
  const columns = new Set(rows.map((row) => row.column_name));
  for (const name of ['request', 'status', 'stage', 'progress', 'slug', 'error']) {
    assert.ok(columns.has(name), `${name} column missing`);
  }

  await database.query("insert into blog_research_jobs (request, status) values ('x', 'queued')");
  await assert.rejects(
    database.query("insert into blog_research_jobs (request, status) values ('x', 'nonsense')"),
    'status is constrained to the known states',
  );
  await database.close();
});
