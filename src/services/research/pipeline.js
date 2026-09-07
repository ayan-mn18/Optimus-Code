import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { chatJson, llmConfigured } from '../../lib/llm.js';
import { companiesFromEvidence, estimateReadMinutes, slugify } from '../blog.service.js';
import { fetchPage, search } from './fetcher.js';
import { resolveLeetCode } from './resolve.js';
import { extractEvidence } from './extract.js';
import {
  checkBlocks, checkLinks, checkOriginality, checkProvenance,
  checkSubstance, stripUnknownWidgets,
} from './validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BLOG_DIR = path.join(here, '..', '..', '..', 'data', 'blogs');

/** Runs `worker` over `items` with a fixed number in flight, preserving order. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Control characters Postgres will not store, and JSON should not carry. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /\\u000[0-8bcef]|\\u001[0-9a-f]|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gi;

export function stripControlChars(text) {
  return text.replace(CONTROL_CHARS, ' ');
}

export const STAGES = ['intake', 'resolve', 'harvest', 'extract', 'compose', 'validate', 'publish'];

/* ---------------------------------------------------------------- intake -- */

const INTAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'title', 'kind', 'template'],
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    title: { type: 'string' },
    kind: { type: 'string', enum: ['LLD', 'HLD', 'DSA', 'General'] },
    topic: { type: 'string' },
    difficulty: { type: 'string', enum: ['Easy', 'Medium', 'Hard'] },
    template: { type: 'string', enum: ['problem', 'concept'] },
    coverEmoji: { type: 'string' },
    searchQueries: { type: 'array', items: { type: 'string' } },
  },
};

/** Turns a structured research brief into a job spec. */
export async function intake(request, { fetchImpl = fetch } = {}) {
  const brief = typeof request === 'string'
    ? { topic: request, goal: '', audience: 'interview', format: 'interview-guide', questions: [], constraints: '' }
    : (request?.brief ?? request);
  const questions = (brief.questions ?? []).filter(Boolean);
  const spec = await chatJson({
    system: `You turn a research brief into a spec for a design write-up.
Set ok=false with a reason if the request is not a software design topic.
template=problem for "design X" interview questions; template=concept for a
topic or mechanism. searchQueries: 4-6 web queries most likely to surface
FIRST-HAND interview reports naming companies — not tutorials. Use the brief's
goal, audience, format, questions, and constraints to choose the exact title,
scope, and search queries. Every user question must be answerable in the final
article; do not broaden the topic into a generic guide.`,
    user: [
      `<topic>${brief.topic ?? ''}</topic>`,
      `<goal>${brief.goal ?? ''}</goal>`,
      `<audience>${brief.audience ?? ''}</audience>`,
      `<format>${brief.format ?? ''}</format>`,
      `<questions>${questions.join('\n')}</questions>`,
      `<constraints>${brief.constraints ?? ''}</constraints>`,
    ].join('\n'),
    schema: INTAKE_SCHEMA,
    schemaName: 'intake',
    effort: 'low',
    maxTokens: 4000,
    fetchImpl,
  });

  if (!spec.ok) throw new Error(spec.reason || 'Not a design topic');
  return { ...spec, slug: slugify(spec.title), brief };
}

/* --------------------------------------------------------------- harvest -- */

/**
 * Ranks a search hit by how likely it is to carry provenance — never by which
 * site it came from. A personal blog naming a company and a round outranks a
 * famous site publishing a tutorial, which is the whole point: the pipeline
 * should keep finding sources nobody thought to list.
 */
export function scoreCandidate(hit) {
  const text = `${hit.title} ${hit.snippet}`.toLowerCase();
  let score = 0;

  // Someone recounting their own interview — the strongest signal there is.
  if (/asked me|i was asked|my interview|interview experience/.test(text)) score += 5;
  if (/\bround \d|onsite|machine coding|lld round|hiring manager/.test(text)) score += 3;
  // A named company plus a level reads like a report rather than an explainer.
  if (/\b(sde|swe|senior|staff|l\d|intern)\b/.test(text)) score += 2;
  if (/\b(19|20)\d\d\b/.test(text)) score += 1;              // a date to cite
  if (/asked at|companies asking|reported at/.test(text)) score += 2;

  // Tutorials explain the problem; they almost never say who asked it.
  if (/tutorial|complete guide|step by step|implementation in|how to implement/.test(text)) score -= 3;
  if (/course|playlist|subscribe/.test(text)) score -= 2;

  return score;
}


/** Search, then read what looks like it might carry provenance. */
export async function harvest(job, { onProgress = () => {}, fetchImpl = fetch } = {}) {
  // Deliberately site-neutral. Naming a site here would bake yesterday's
  // best source into tomorrow's search; ranking below sorts on what a page
  // looks like, not on where it is hosted.
  const queries = (job.searchQueries?.length ? job.searchQueries : [
    `"${job.title}" interview experience asked round`,
    `${job.title} interview question asked at company`,
    `"${job.title}" asked me in my interview`,
    `${job.title} machine coding round interview experience`,
  ]).slice(0, env.research.maxSearches);

  const seen = new Set();
  const candidates = [];
  for (const query of queries) {
    for (const hit of await search(query, { limit: 6, fetchImpl })) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      candidates.push(hit);
    }
    onProgress(`searched: ${query}`);
  }

  candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

  // Fetches are independent and mostly network-bound, so they run in parallel.
  // fetchPage still rate-limits per host internally, so this stays polite.
  return mapWithConcurrency(
    candidates.slice(0, job.template === 'concept' ? 4 : env.research.maxFetches),
    env.research.fetchConcurrency,
    async (hit) => {
      const page = await fetchPage(hit.url, { fetchImpl });
      onProgress(`${page.ok ? 'read' : 'skipped'}: ${page.host}`);
      return { ...page, title: hit.title, source: page.host };
    },
  );
}

/* -------------------------------------------------------------- assemble -- */

function buildRefs(job, pages) {
  const refs = [];
  if (job.leetcode) {
    refs.push({
      title: `LeetCode ${job.leetcode.id} — ${job.leetcode.title}`,
      url: job.leetcode.url,
      source: 'LeetCode',
      kind: 'problem',
      note: `${job.leetcode.difficulty}. Resolved through the LeetCode API, not guessed from the slug.`,
    });
  }
  for (const page of pages.filter((p) => p.ok).slice(0, 6)) {
    refs.push({ title: page.title || page.host, url: page.url, source: page.host, kind: 'article' });
  }
  return refs;
}

/* ------------------------------------------------------------------ run --- */

/**
 * The pipeline writes an auditable data/blogs/<slug>.json document. Batch CLI
 * runs still publish through `npm run seed:blogs`; the on-demand job worker
 * also inserts the returned document into the database for review.
 */
export async function runPipeline(request, { onStage = () => {}, fetchImpl = fetch, force = false } = {}) {
  if (!llmConfigured()) throw new Error('No LLM_API_KEY configured — set LLM_BASE_URL and LLM_API_KEY');
  if (!env.research.enabled) throw new Error('No FIRECRAWL_API_KEY configured');

  const log = [];
  const note = (message) => { log.push(message); onStage(message); };

  // 1. intake
  onStage('intake');
  const job = typeof request === 'string' || request?.brief
    ? await intake(request, { fetchImpl })
    : request;
  note(`intake: ${job.title} (${job.kind}, ${job.template})`);

  const file = path.join(BLOG_DIR, `${job.slug}.json`);
  if (!force) {
    const exists = await fs.access(file).then(() => true).catch(() => false);
    if (exists) return { slug: job.slug, skipped: 'already written', log };
  }

  // 2. resolve
  onStage('resolve');
  job.leetcode = await resolveLeetCode(job.title, { fetchImpl });
  note(job.leetcode ? `resolve: LeetCode ${job.leetcode.id}` : 'resolve: no LeetCode twin');

  // 3. harvest
  //
  // Concept pages skip provenance entirely. "Asked in companies" is meaningless
  // for a page about consistent hashing, and harvesting for it would spend the
  // most expensive part of the pipeline on evidence nobody would publish. They
  // still get reference material, just far less of it.
  onStage('harvest');
  const wantsProvenance = job.template === 'problem';
  const pages = wantsProvenance
    ? await harvest(job, { onProgress: note, fetchImpl })
    : await harvest({ ...job, searchQueries: [`${job.title} explained`, `${job.title} trade-offs`] },
      { onProgress: note, fetchImpl });

  const readable = pages.filter((page) => page.ok);
  note(`harvest: ${readable.length}/${pages.length} pages readable${wantsProvenance ? '' : ' (concept — no provenance pass)'}`);
  if (!readable.length) throw new Error('No readable sources found');

  // 4. extract
  onStage('extract');
  // One call per page, and they do not depend on each other — the sequential
  // version spent most of a run waiting on a reasoning model one page at a time.
  const raw = wantsProvenance
    ? (await mapWithConcurrency(readable, env.research.llmConcurrency, (page) =>
      extractEvidence(page, job.title, { fetchImpl }).catch(() => null))).filter(Boolean)
    : [];
  const { evidence, dropped } = checkProvenance(raw);
  note(`extract: ${evidence.length} sources with company claims, ${dropped.length} claims dropped on quote check`);

  // 5. compose, 6. validate, with one revision
  let article;
  let problems = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    onStage(attempt === 1 ? 'compose' : 'revise');
    article = await composeWith(job, evidence, readable, problems, fetchImpl);

    onStage('validate');
    const stripped = stripUnknownWidgets(article.blocks);
    article.blocks = stripped.blocks;
    if (stripped.removed.length) note(`validate: stripped widgets ${stripped.removed.join(', ')}`);

    problems = [
      ...checkBlocks(article.blocks),
      ...checkSubstance(article.blocks, job),
      ...checkOriginality(article.blocks, readable),
    ];
    if (!problems.length) break;
    note(`validate: ${problems.length} problem(s) — ${problems.slice(0, 3).join('; ')}`);
    if (problems.some((p) => p.startsWith('copies'))) break;   // no retry on the copyright gate
  }

  const { refs, dropped: deadLinks } = await checkLinks(buildRefs(job, readable), { fetchImpl });
  if (deadLinks.length) note(`validate: dropped ${deadLinks.length} dead ref(s)`);

  // 7. write the file — the pipeline's only output
  onStage('publish');
  const doc = {
    slug: job.slug,
    title: job.title,
    summary: article.summary,
    kind: job.kind,
    problemSlug: job.problemSlug,
    topic: job.topic ?? null,
    difficulty: job.difficulty ?? null,
    coverEmoji: article.coverEmoji || job.coverEmoji || '📘',
    origin: 'pipeline',
    authorName: 'Optimus Code',
    status: problems.length || !env.research.autoPublish ? 'draft' : 'published',
    tags: article.tags ?? [],
    evidence,
    refs,
    blocks: article.blocks,
    generatedBy: { model: env.ai.model, at: new Date().toISOString(), problems },
  };

  await fs.mkdir(BLOG_DIR, { recursive: true });
  // Postgres text columns reject raw control characters (SQLSTATE 22P05), and a
  // single one anywhere in a 280-article batch fails the whole seed. Strip them
  // where the document is written rather than discovering it at insert time.
  await fs.writeFile(file, stripControlChars(JSON.stringify(doc, null, 2)));

  return {
    slug: job.slug,
    status: doc.status,
    file,
    blocks: doc.blocks.length,
    readMinutes: estimateReadMinutes(doc.blocks),
    evidence: evidence.length,
    companies: companiesFromEvidence(evidence).length,
    document: { ...doc, readMinutes: estimateReadMinutes(doc.blocks) },
    problems,
    log,
  };
}

async function composeWith(job, evidence, pages, problems, fetchImpl) {
  const { composeArticle } = await import('./compose.js');
  const withFeedback = problems.length
    ? { ...job, title: `${job.title}\n\nThe previous attempt was rejected for: ${problems.join('; ')}. Fix all of them.` }
    : job;
  return composeArticle(withFeedback, evidence, pages, { fetchImpl });
}
