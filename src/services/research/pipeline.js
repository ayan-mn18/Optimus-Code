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

/** Turns "design a text editor LLD question" into a job spec. */
export async function intake(request, { fetchImpl = fetch } = {}) {
  const spec = await chatJson({
    system: `You turn a free-text request into a spec for a design write-up.
Set ok=false with a reason if the request is not a software design topic.
template=problem for "design X" interview questions; template=concept for a
topic or mechanism. searchQueries: 4-6 web queries most likely to surface
FIRST-HAND interview reports naming companies — not tutorials.`,
    user: request,
    schema: INTAKE_SCHEMA,
    schemaName: 'intake',
    effort: 'low',
    maxTokens: 4000,
    fetchImpl,
  });

  if (!spec.ok) throw new Error(spec.reason || 'Not a design topic');
  return { ...spec, slug: slugify(spec.title) };
}

/* --------------------------------------------------------------- harvest -- */

/** Search, then read what looks like it might carry provenance. */
export async function harvest(job, { onProgress = () => {}, fetchImpl = fetch } = {}) {
  const queries = (job.searchQueries?.length ? job.searchQueries : [
    `"${job.title}" interview experience asked round`,
    `${job.title} interview question asked at company`,
    `geeksforgeeks interview experience "${job.title}"`,
    `${job.title} low level design interview asked`,
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

  // Prefer pages whose title or snippet smells like a first-hand account.
  const smellsFirstHand = (hit) =>
    /interview experience|asked me|interview questions|onsite|round \d/i.test(`${hit.title} ${hit.snippet}`);
  candidates.sort((a, b) => Number(smellsFirstHand(b)) - Number(smellsFirstHand(a)));

  const pages = [];
  for (const hit of candidates.slice(0, env.research.maxFetches)) {
    const page = await fetchPage(hit.url, { fetchImpl });
    pages.push({ ...page, title: hit.title, source: page.host });
    onProgress(`${page.ok ? 'read' : 'skipped'}: ${page.host}`);
  }
  return pages;
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
 * The whole pipeline. Writes data/blogs/<slug>.json and nothing else —
 * publishing stays `npm run seed:blogs`, so research never touches the database
 * and a bad run is reverted with git rather than SQL.
 */
export async function runPipeline(request, { onStage = () => {}, fetchImpl = fetch, force = false } = {}) {
  if (!llmConfigured()) throw new Error('No LLM_API_KEY configured — set LLM_BASE_URL and LLM_API_KEY');
  if (!env.research.enabled) throw new Error('No FIRECRAWL_API_KEY configured');

  const log = [];
  const note = (message) => { log.push(message); onStage(message); };

  // 1. intake
  onStage('intake');
  const job = typeof request === 'string' ? await intake(request, { fetchImpl }) : request;
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
  onStage('harvest');
  const pages = await harvest(job, { onProgress: note, fetchImpl });
  const readable = pages.filter((page) => page.ok);
  note(`harvest: ${readable.length}/${pages.length} pages readable`);
  if (!readable.length) throw new Error('No readable sources found');

  // 4. extract
  onStage('extract');
  const raw = [];
  for (const page of readable) {
    const found = await extractEvidence(page, job.title, { fetchImpl }).catch(() => null);
    if (found) raw.push(found);
  }
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
  await fs.writeFile(file, JSON.stringify(doc, null, 2));

  return {
    slug: job.slug,
    status: doc.status,
    file,
    blocks: doc.blocks.length,
    readMinutes: estimateReadMinutes(doc.blocks),
    evidence: evidence.length,
    companies: companiesFromEvidence(evidence).length,
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
