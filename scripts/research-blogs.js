/**
 * Research CLI — the batch half of the pipeline.
 *
 *   npm run research -- --topic "design a text editor"     one ad-hoc topic
 *   npm run research -- --limit 5 --kind LLD               next 5 unwritten
 *   npm run research -- --only design-parking-lot-42-82    one catalogue entry
 *
 * Writes data/blogs/<slug>.json and nothing else. Publish with:
 *   npm run seed:blogs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { mapWithConcurrency, runPipeline } from '../src/services/research/pipeline.js';
import { slugify } from '../src/services/blog.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? true);
};

const PROBLEM_TOPICS = new Set([
  'LLD Interview Problems', 'More Interview Problems',
  'LLD + Concurrency Interview Problems', 'Concurrency Interview Problems',
]);

async function catalogueQueue() {
  const catalogue = JSON.parse(await fs.readFile(path.join(root, 'data', 'system-design.json'), 'utf8'));
  const written = new Set(
    (await fs.readdir(path.join(root, 'data', 'blogs')).catch(() => []))
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, '')),
  );

  const only = flag('only');
  const kind = flag('kind');
  const topic = flag('topic');

  return catalogue
    .filter((problem) => (only ? problem.slug === only : true))
    .filter((problem) => (kind ? problem.kind === kind : true))
    .filter((problem) => (topic ? problem.topic === topic : true))
    .map((problem) => ({
      title: problem.title,
      slug: slugify(problem.title),
      problemSlug: problem.slug,
      kind: problem.kind,
      topic: problem.topic,
      difficulty: problem.difficulty,
      template: PROBLEM_TOPICS.has(problem.topic) || /^design\b/i.test(problem.title) ? 'problem' : 'concept',
    }))
    .filter((job) => flag('force') || !written.has(job.slug))
    // Interview problems first — they are where the company evidence is.
    .sort((a, b) => Number(b.template === 'problem') - Number(a.template === 'problem'));
}

const ask = flag('topic') && !flag('only') && argv.includes('--topic') && !argv.includes('--kind');

const queue = ask
  ? [flag('topic')]
  : (await catalogueQueue()).slice(0, Number(flag('limit', 1)));

if (!queue.length) {
  console.log('nothing to do — every matching entry already has a file');
  process.exit(0);
}

console.log(`model: ${env.ai.model}`);
console.log(`firecrawl: ${env.research.firecrawlKey ? 'configured' : 'MISSING'} · browser use: ${env.research.browserUseKey ? 'configured' : 'not set'}`);
console.log(`queue: ${queue.length}`);
const startedAt = Date.now();

// Articles are wholly independent, so they run several at a time. Per-stage
// concurrency inside a run still applies, and fetchPage rate-limits per host,
// so widening this does not make us rude to any one site.
const lanes = Number(flag('concurrency', env.research.concurrency));
console.log(`running ${lanes} at a time\n`);

let ok = 0;
let done = 0;

const results = await mapWithConcurrency(queue, lanes, async (job) => {
  const label = typeof job === 'string' ? job : job.title;
  try {
    const result = await runPipeline(job, { force: Boolean(flag('force')) });
    done += 1;
    if (result.skipped) {
      console.log(`[${done}/${queue.length}] · ${label} — skipped: ${result.skipped}`);
      return null;
    }
    ok += 1;
    console.log(`[${done}/${queue.length}] ✓ ${result.slug} — ${result.blocks} blocks, `
      + `~${result.readMinutes} min, ${result.evidence} sources → ${result.companies} companies, ${result.status}`);
    if (result.problems?.length) console.log(`            ! ${result.problems.join('; ')}`);
    return result;
  } catch (error) {
    done += 1;
    console.error(`[${done}/${queue.length}] ✗ ${label} — ${error.message}`);
    return null;
  }
});

const elapsed = ((Date.now() - startedAt) / 60_000).toFixed(1);
console.log(`\ndone — ${ok}/${queue.length} written in ${elapsed}m. Publish with: npm run seed:blogs`);
void results;
process.exit(0);
