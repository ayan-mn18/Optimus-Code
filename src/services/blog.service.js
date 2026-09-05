import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';

const LIST_FIELDS = [
  'id', 'slug', 'title', 'summary', 'kind', 'problem_id', 'topic', 'difficulty',
  'author_id', 'author_name', 'origin', 'status', 'cover_emoji', 'read_minutes',
  'tags', 'evidence', 'companies', 'refs', 'views', 'likes', 'published_at', 'created_at', 'updated_at',
].join(', ');

const FULL_FIELDS = `${LIST_FIELDS}, blocks`;

/** Words a reader gets through in a minute — the usual estimate for technical prose. */
const WORDS_PER_MINUTE = 200;

function toBlog(row, { user, liked = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? '',
    kind: row.kind,
    problemId: row.problem_id,
    topic: row.topic,
    difficulty: row.difficulty,
    author: { id: row.author_id, name: row.author_name },
    origin: row.origin,
    status: row.status,
    coverEmoji: row.cover_emoji,
    readMinutes: row.read_minutes,
    tags: row.tags ?? [],
    evidence: row.evidence ?? [],
    companies: row.companies ?? [],
    refs: row.refs ?? [],
    views: row.views,
    likes: row.likes,
    liked,
    isAuthor: Boolean(user && row.author_id && row.author_id === user.id),
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.blocks ? { blocks: row.blocks } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Company tags are derived, never authored                                    */
/*                                                                             */
/* Evidence is keyed on the source: one link, every company it names. Rolling  */
/* that up per company is what stops seven company cards from all pointing at  */
/* the same URL — each company ends up with the sources that actually mention  */
/* it, and a company no source mentions cannot exist at all.                   */
/* -------------------------------------------------------------------------- */

/** Ranked weakest to strongest; a company inherits its best evidence. */
const CONFIDENCE = { roundup: 1, aggregate: 2, report: 3 };
const CONFIDENCE_LABEL = { 1: 'claimed', 2: 'aggregated', 3: 'reported' };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "Jun 2026" / "2016" -> a sortable integer. Unparseable dates sort last. */
function dateRank(value) {
  if (!value) return 0;
  const match = String(value).trim().match(/^(?:([A-Za-z]{3})[a-z]*\s+)?(\d{4})$/);
  if (!match) return 0;
  const month = match[1] ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : 0;
  return Number(match[2]) * 100 + month;
}

export function companiesFromEvidence(evidence = []) {
  const byName = new Map();

  for (const item of evidence) {
    if (!item?.url) continue;
    const weight = CONFIDENCE[item.kind] ?? CONFIDENCE.roundup;

    for (const mention of item.companies ?? []) {
      const name = typeof mention === 'string' ? mention : mention?.name;
      if (!name) continue;

      const entry = byName.get(name) ?? { name, sources: [], roles: new Set(), rank: 0, confidence: 0 };
      if (!entry.sources.includes(item.url)) entry.sources.push(item.url);
      if (mention.role) entry.roles.add(mention.role);
      entry.confidence = Math.max(entry.confidence, weight);

      const rank = dateRank(mention.date);
      if (rank > entry.rank) {
        entry.rank = rank;
        entry.lastSeen = mention.date;
      }
      byName.set(name, entry);
    }
  }

  return [...byName.values()]
    .map(({ roles, rank: _rank, confidence, ...entry }) => ({
      ...entry,
      count: entry.sources.length,
      roles: [...roles],
      confidence: CONFIDENCE_LABEL[confidence],
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Flattens every string a block renders so read time and search see real prose. */
function blockText(block) {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return block.text ?? '';
    case 'list':
      return (block.items ?? []).join(' ');
    case 'callout':
      return `${block.title ?? ''} ${block.text ?? ''}`;
    case 'code':
      return block.code ?? '';
    case 'steps':
      return (block.items ?? []).map((item) => `${item.title ?? ''} ${item.text ?? ''}`).join(' ');
    case 'table':
      return [...(block.headers ?? []), ...(block.rows ?? []).flat()].join(' ');
    default:
      return '';
  }
}

export function estimateReadMinutes(blocks) {
  const words = blocks.map(blockText).join(' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

/** Appends -2, -3 … until the slug is free. `ignoreId` lets a blog keep its own. */
async function uniqueSlug(base, ignoreId) {
  const taken = new Set(
    unwrap(await db.from('blogs').select('id, slug').like('slug', `${base}%`), 'check blog slugs')
      .filter((row) => row.id !== ignoreId)
      .map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

async function likedSlugs(user, blogIds) {
  if (!user || !blogIds.length) return new Set();
  const rows = unwrap(
    await db.from('blog_likes').select('blog_id').eq('user_id', user.id).in('blog_id', blogIds),
    'load blog likes',
  );
  return new Set(rows.map((row) => row.blog_id));
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function listBlogs(user, { kind, topic, company, tag, search, problemId, sort, page, pageSize }) {
  let query = db.from('blogs').select(LIST_FIELDS).eq('status', 'published');
  if (kind) query = query.eq('kind', kind);
  if (topic) query = query.eq('topic', topic);
  if (problemId) query = query.eq('problem_id', problemId);
  if (tag) query = query.contains('tags', [tag]);

  const rows = unwrap(await query, 'load blogs');

  const term = search?.trim().toLocaleLowerCase();
  const matched = rows
    .filter((row) => !company || (row.companies ?? []).some((entry) => entry.name === company))
    .filter((row) => !term || `${row.title} ${row.summary ?? ''} ${row.topic ?? ''} ${(row.tags ?? []).join(' ')}`
      .toLocaleLowerCase()
      .includes(term));

  const sorted = [...matched].sort((a, b) => {
    if (sort === 'popular') return b.views - a.views || b.likes - a.likes;
    if (sort === 'liked') return b.likes - a.likes || b.views - a.views;
    return Date.parse(b.published_at ?? b.created_at) - Date.parse(a.published_at ?? a.created_at);
  });

  const start = (page - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);
  const liked = await likedSlugs(user, pageRows.map((row) => row.id));

  // Facets come off the unfiltered published set so a filter never hides its
  // own sibling options.
  const topics = [...new Set(rows.map((row) => row.topic).filter(Boolean))].sort();
  const tags = [...new Set(rows.flatMap((row) => row.tags ?? []))].sort();
  const companyCounts = new Map();
  for (const row of rows) {
    for (const entry of row.companies ?? []) {
      companyCounts.set(entry.name, (companyCounts.get(entry.name) ?? 0) + 1);
    }
  }

  return {
    items: pageRows.map((row) => toBlog(row, { user, liked: liked.has(row.id) })),
    total: sorted.length,
    page,
    pageSize,
    facets: {
      topics,
      tags,
      companies: [...companyCounts.entries()]
        .map(([name, blogs]) => ({ name, blogs }))
        .sort((a, b) => b.blogs - a.blogs || a.name.localeCompare(b.name)),
      kinds: [...new Set(rows.map((row) => row.kind))].sort(),
    },
  };
}

export async function getBlog(user, slug) {
  const row = unwrap(
    await db.from('blogs').select(FULL_FIELDS).eq('slug', slug).maybeSingle(),
    'load blog',
  );
  if (!row) throw ApiError.notFound('Blog not found');
  if (row.status !== 'published' && row.author_id !== user?.id) throw ApiError.notFound('Blog not found');

  if (row.status === 'published') {
    // Best-effort: a failed counter must never cost the reader the article.
    const { data } = await db.rpc('increment_blog_views', { p_slug: slug });
    if (typeof data === 'number') row.views = data;
  }

  const [liked, related] = await Promise.all([
    likedSlugs(user, [row.id]),
    unwrap(
      await db
        .from('blogs')
        .select(LIST_FIELDS)
        .eq('status', 'published')
        .eq('kind', row.kind)
        .neq('id', row.id)
        .order('views', { ascending: false })
        .limit(3),
      'load related blogs',
    ),
  ]);

  return {
    blog: toBlog(row, { user, liked: liked.has(row.id) }),
    related: related.map((entry) => toBlog(entry, { user })),
  };
}

export async function listMyBlogs(user) {
  const rows = unwrap(
    await db.from('blogs').select(LIST_FIELDS).eq('author_id', user.id).order('updated_at', { ascending: false }),
    'load your blogs',
  );
  return { items: rows.map((row) => toBlog(row, { user })) };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export async function createBlog(user, payload) {
  const slug = await uniqueSlug(slugify(payload.slug || payload.title));
  const publish = payload.status === 'published';

  const row = unwrap(
    await db
      .from('blogs')
      .insert({
        slug,
        title: payload.title,
        summary: payload.summary ?? null,
        kind: payload.kind,
        problem_id: payload.problemId ?? null,
        topic: payload.topic ?? null,
        difficulty: payload.difficulty ?? null,
        author_id: user.id,
        author_name: user.name,
        origin: 'user',
        status: publish ? 'published' : 'draft',
        cover_emoji: payload.coverEmoji ?? '📘',
        read_minutes: estimateReadMinutes(payload.blocks ?? []),
        blocks: payload.blocks ?? [],
        tags: payload.tags ?? [],
        evidence: payload.evidence ?? [],
        companies: companiesFromEvidence(payload.evidence ?? []),
        refs: payload.refs ?? [],
        published_at: publish ? new Date().toISOString() : null,
      })
      .select(FULL_FIELDS)
      .single(),
    'create blog',
  );

  return toBlog(row, { user });
}

export async function updateBlog(user, id, payload) {
  const existing = unwrap(
    await db.from('blogs').select('id, slug, author_id, status').eq('id', id).maybeSingle(),
    'load blog for update',
  );
  if (!existing) throw ApiError.notFound('Blog not found');
  if (existing.author_id !== user.id) throw ApiError.forbidden('This blog belongs to someone else');

  const patch = { updated_at: new Date().toISOString() };
  if (payload.title !== undefined) patch.title = payload.title;
  if (payload.summary !== undefined) patch.summary = payload.summary;
  if (payload.kind !== undefined) patch.kind = payload.kind;
  if (payload.problemId !== undefined) patch.problem_id = payload.problemId;
  if (payload.topic !== undefined) patch.topic = payload.topic;
  if (payload.difficulty !== undefined) patch.difficulty = payload.difficulty;
  if (payload.coverEmoji !== undefined) patch.cover_emoji = payload.coverEmoji;
  if (payload.tags !== undefined) patch.tags = payload.tags;
  if (payload.evidence !== undefined) {
    patch.evidence = payload.evidence;
    patch.companies = companiesFromEvidence(payload.evidence);
  }
  if (payload.refs !== undefined) patch.refs = payload.refs;
  if (payload.blocks !== undefined) {
    patch.blocks = payload.blocks;
    patch.read_minutes = estimateReadMinutes(payload.blocks);
  }
  if (payload.slug !== undefined) patch.slug = await uniqueSlug(slugify(payload.slug), id);
  if (payload.status !== undefined) {
    patch.status = payload.status;
    // First publish stamps the date; unpublishing and re-publishing keeps it.
    if (payload.status === 'published' && existing.status !== 'published') {
      patch.published_at = new Date().toISOString();
    }
  }

  const row = unwrap(
    await db.from('blogs').update(patch).eq('id', id).select(FULL_FIELDS).single(),
    'update blog',
  );
  return toBlog(row, { user });
}

export async function deleteBlog(user, id) {
  const existing = unwrap(
    await db.from('blogs').select('id, author_id').eq('id', id).maybeSingle(),
    'load blog for delete',
  );
  if (!existing) throw ApiError.notFound('Blog not found');
  if (existing.author_id !== user.id) throw ApiError.forbidden('This blog belongs to someone else');

  unwrap(await db.from('blogs').delete().eq('id', id), 'delete blog');
}

export async function toggleBlogLike(user, id) {
  const { data, error } = await db.rpc('toggle_blog_like', { p_blog_id: id, p_user_id: user.id });
  if (error) throw ApiError.notFound('Blog not found');
  const result = Array.isArray(data) ? data[0] : data;
  return { liked: Boolean(result?.liked), likes: result?.likes ?? 0 };
}

/** Slug per problem id, so the System Design catalogue can deep-link to a write-up. */
export async function blogSlugsByProblem(problemIds) {
  if (!problemIds.length) return new Map();
  const rows = unwrap(
    await db.from('blogs').select('slug, problem_id').eq('status', 'published').in('problem_id', problemIds),
    'load blog links',
  );
  return new Map(rows.filter((row) => row.problem_id).map((row) => [row.problem_id, row.slug]));
}
