import { db, unwrap } from '../../lib/supabase.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../lib/errors.js';
import { companiesFromEvidence } from '../blog.service.js';
import { runPipeline } from './pipeline.js';

/**
 * Job queue for pipeline runs.
 *
 * Runs happen in-process, detached from the request. The row is the only
 * coordination point, so the page polls it and a crash leaves a `running` row
 * that the next boot can reap rather than a half-written article.
 */

const FIELDS = 'id, user_id, request, brief, status, stage, progress, slug, blog_id, error, model_version, started_at, finished_at, created_at';

const storedBrief = (row) => row.brief?.topic ? row.brief : {
  topic: row.request,
  goal: '',
  audience: 'interview',
  format: 'interview-guide',
  questions: [],
  constraints: '',
};

const toJob = (row) => row && ({
  id: row.id,
  request: row.request,
  brief: storedBrief(row),
  status: row.status,
  stage: row.stage,
  progress: row.progress ?? [],
  slug: row.slug,
  blogId: row.blog_id,
  error: row.error,
  modelVersion: row.model_version,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
});

/** One running job per user at a time — a run costs money and takes minutes. */
async function assertNoActiveRun(userId) {
  const active = unwrap(
    await db.from('blog_research_jobs').select('id')
      .eq('user_id', userId).in('status', ['queued', 'running']).limit(1),
    'check active research jobs',
  );
  if (active.length) throw ApiError.conflict('You already have a research run in progress');
}

export async function createJob(user, brief) {
  if (!env.research.enabled) throw ApiError.serviceUnavailable('Research search is not connected on this server yet');
  await assertNoActiveRun(user.id);

  const row = unwrap(
    await db.from('blog_research_jobs')
      .insert({ user_id: user.id, request: brief.topic, brief, status: 'queued', model_version: env.ai.model })
      .select(FIELDS).single(),
    'create research job',
  );

  // Detached on purpose: the HTTP response returns immediately.
  void execute(row.id).catch(() => {});
  return toJob(row);
}

async function patch(id, changes) {
  unwrap(
    await db.from('blog_research_jobs').update({ ...changes, updated_at: new Date().toISOString() }).eq('id', id),
    'update research job',
  );
}

async function publishPipelineDocument(document) {
  const baseSlug = document.slug;
  let slug = baseSlug;
  const existing = unwrap(
    await db.from('blogs').select('id').eq('slug', slug).maybeSingle(),
    'check generated blog slug',
  );
  if (existing) slug = `${baseSlug}-${Date.now().toString(36)}`.slice(0, 80);

  const row = unwrap(
    await db.from('blogs').insert({
      slug,
      title: document.title,
      summary: document.summary ?? null,
      kind: document.kind ?? 'LLD',
      topic: document.topic ?? null,
      difficulty: document.difficulty ?? null,
      author_id: null,
      author_name: 'Optimus Code',
      origin: 'pipeline',
      status: document.status ?? 'draft',
      cover_emoji: document.coverEmoji ?? '📘',
      read_minutes: document.readMinutes ?? 5,
      blocks: document.blocks ?? [],
      tags: document.tags ?? [],
      evidence: document.evidence ?? [],
      companies: companiesFromEvidence(document.evidence ?? []),
      refs: document.refs ?? [],
      published_at: document.status === 'published' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).select('id, slug').single(),
    'publish generated blog',
  );
  return row;
}

async function execute(id) {
  const row = unwrap(
    await db.from('blog_research_jobs').select(FIELDS).eq('id', id).maybeSingle(),
    'load research job',
  );
  if (!row) return;

  const progress = [];
  const onStage = async (message) => {
    progress.push({ at: new Date().toISOString(), message });
    await patch(id, { stage: message, progress }).catch(() => {});
  };

  await patch(id, { status: 'running', started_at: new Date().toISOString() });

  try {
    const result = await Promise.race([
      // An on-demand run must always return a document for the database
      // publisher. Batch CLI runs keep the file-based skip optimisation.
      runPipeline({ ...row, brief: storedBrief(row) }, { onStage, force: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Research timed out')), env.research.timeoutMs)),
    ]);

    let blog;
    if (result.document) {
      blog = await publishPipelineDocument(result.document);
    } else if (result.skipped) {
      blog = unwrap(
        await db.from('blogs').select('id, slug').eq('slug', result.slug).maybeSingle(),
        'load existing generated blog',
      );
      if (!blog) throw new Error('A draft for this topic already exists locally but is not published in the catalogue');
    } else {
      throw new Error('Research completed without producing a draft');
    }
    await patch(id, {
      status: result.status === 'published' ? 'published' : 'needs_review',
      stage: 'done',
      slug: blog.slug,
      blog_id: blog.id,
      progress,
      finished_at: new Date().toISOString(),
    });
  } catch (error) {
    await patch(id, {
      status: 'failed',
      stage: 'failed',
      error: error.message,
      progress,
      finished_at: new Date().toISOString(),
    });
  }
}

export async function getJob(user, id) {
  const row = unwrap(
    await db.from('blog_research_jobs').select(FIELDS).eq('id', id).maybeSingle(),
    'load research job',
  );
  if (!row) throw ApiError.notFound('Research job not found');
  if (row.user_id !== user.id) throw ApiError.forbidden('That job belongs to someone else');
  return toJob(row);
}

export async function listJobs(user) {
  const rows = unwrap(
    await db.from('blog_research_jobs').select(FIELDS)
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(10),
    'list research jobs',
  );
  return { items: rows.map(toJob) };
}

export async function cancelJob(user, id) {
  const job = await getJob(user, id);
  if (['published', 'failed'].includes(job.status)) return job;
  await patch(id, { status: 'failed', error: 'Cancelled', finished_at: new Date().toISOString() });
  return { ...job, status: 'failed', error: 'Cancelled' };
}
