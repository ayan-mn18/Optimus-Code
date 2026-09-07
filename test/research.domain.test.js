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
  for (const name of ['request', 'brief', 'status', 'stage', 'progress', 'slug', 'error']) {
    assert.ok(columns.has(name), `${name} column missing`);
  }

  await database.query("insert into blog_research_jobs (request, status) values ('x', 'queued')");
  await assert.rejects(
    database.query("insert into blog_research_jobs (request, status) values ('x', 'nonsense')"),
    'status is constrained to the known states',
  );
  await database.close();
});

test('candidates are ranked on what a page looks like, never on its host', async () => {
  const { scoreCandidate } = await import('../src/services/research/pipeline.js');

  const report = { title: 'Amazon SDE-II interview experience', snippet: 'Round 1 LLD, they asked me to design a parking lot, 2024' };
  const unknownBlog = { title: 'some personal blog', snippet: 'I was asked this at Swiggy in my SDE-2 onsite round 3' };
  const famousTutorial = { title: 'Design a Parking Lot — Complete Guide', snippet: 'Step by step implementation in Java' };

  assert.ok(scoreCandidate(report) > scoreCandidate(famousTutorial));
  assert.ok(
    scoreCandidate(unknownBlog) > scoreCandidate(famousTutorial),
    'an unknown blog carrying a first-hand account must outrank a well-known tutorial',
  );
  assert.ok(scoreCandidate(famousTutorial) < 0, 'tutorials are penalised — they explain, they do not attribute');
});

test('fallback search queries name no website', async () => {
  const source = await fs.readFile(new URL('../src/services/research/pipeline.js', import.meta.url), 'utf8');
  const harvest = source.slice(source.indexOf('export async function harvest'), source.indexOf('/* -------------------------------------------------------------- assemble'));
  for (const site of ['geeksforgeeks', 'hellointerview', 'reddit', 'medium', 'leetcode']) {
    assert.ok(!harvest.includes(site), `harvest must not favour ${site} — that bakes today's best source into tomorrow's search`);
  }
});

test('a quote that repeats across pages is site furniture, not corroboration', () => {
  // The real failure: LinkedIn renders a recommended-posts sidebar on every
  // post, so one promotional blurb was scraped from four URLs and counted as
  // four independent sources. Each quote IS on each page, so the substring
  // check passes — recurrence is the only tell.
  const chrome = 'Excited to share a high-score interview experience from a Bugfree user';
  const evidence = ['a', 'b', 'c', 'd'].map((id) => ({
    url: `https://www.linkedin.com/posts/${id}`,
    companies: [{ name: 'LinkedIn', quote: chrome }],
    _pageText: `Some unrelated post about ${id}. ${chrome}. More text.`,
  }));

  const { evidence: kept, dropped } = checkProvenance(evidence);
  assert.deepEqual(kept, [], 'boilerplate must not survive as four corroborating sources');
  assert.equal(dropped.length, 4);
  assert.ok(dropped[0].includes('repeats across pages'));
});

test('a genuine quote appearing on exactly one page still survives', () => {
  const page = 'Round 3. They asked me to design a bounded blocking queue at Uber.';
  const { evidence } = checkProvenance([
    { url: 'https://example.com/one', companies: [{ name: 'Uber', quote: 'design a bounded blocking queue at Uber' }], _pageText: page },
    { url: 'https://example.com/two', companies: [{ name: 'Grab', quote: 'asked me to implement an ATM dispenser' }], _pageText: 'They asked me to implement an ATM dispenser in round 2.' },
  ]);
  assert.equal(evidence.length, 2, 'distinct quotes from distinct pages are unaffected');
});

test('mapWithConcurrency preserves order and caps what is in flight', async () => {
  const { mapWithConcurrency } = await import('../src/services/research/pipeline.js');
  let inFlight = 0;
  let peak = 0;

  const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return n * 2;
  });

  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16], 'results stay in input order');
  assert.ok(peak <= 3, `never more than 3 in flight, saw ${peak}`);
  assert.ok(peak > 1, 'and it actually parallelised');
});

test('a truncated unicode escape is repaired rather than losing the article', async () => {
  const { repairJson } = await import('../src/lib/llm.js');

  // The real failure: "unexpected end of hex escape at column 11411" threw away
  // a complete 35-block article over two stray characters.
  const broken = '{"summary":"bad \\u12","blocks":[]}';
  assert.throws(() => JSON.parse(broken));
  assert.deepEqual(JSON.parse(repairJson(broken)), { summary: 'bad \\u12', blocks: [] });

  // Valid escapes and ordinary content must survive untouched.
  const fine = '{"a":"fine \\u0041 ok","b":"tab\\tsep"}';
  assert.deepEqual(JSON.parse(repairJson(fine)), JSON.parse(fine));
});

test('a lone surrogate in scraped text does not 400 the whole request', async () => {
  const { sanitiseForJson } = await import('../src/lib/llm.js');

  // The real failure: one orphaned surrogate in a scraped page made
  // JSON.stringify emit \ud800, which Meta rejected as "unexpected end of hex
  // escape" — losing a complete article over an invisible character.
  const damaged = 'interview text \uD800 more text';
  assert.ok(JSON.stringify({ t: damaged }).includes('\\ud800'));
  assert.ok(!JSON.stringify({ t: sanitiseForJson(damaged) }).includes('\\ud800'));

  // Real pairs — emoji, CJK, accents — must survive untouched.
  const fine = 'emoji 🗂️ CJK 日本語 accents café';
  assert.equal(sanitiseForJson(fine), fine);
});
