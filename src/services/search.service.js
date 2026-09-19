import { db, unwrap } from '../lib/supabase.js';
import { getOrSetCached } from '../lib/cache.js';

const SEARCH_TTL_MS = 30_000;
const INDEX_TTL_MS = 5 * 60_000;
const RESULT_LIMIT = 8;
const CANDIDATE_LIMIT = 1_000;
const SEARCH_FIELDS = 'id, slug, title, kind, topic, subtopic, difficulty, description';
const BLOG_FIELDS = 'id, slug, title, kind, topic, difficulty, summary, tags';
const INDEX_PROBLEM_FIELDS = 'id, slug, title, kind, topic, subtopic, difficulty';
const INDEX_BLOG_FIELDS = 'id, slug, title, kind, topic, difficulty';
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'design', 'do', 'explain', 'find', 'for',
  'how', 'i', 'in', 'is', 'me', 'of', 'or', 'please', 'show', 'the', 'to', 'what',
  'with', 'would', 'you',
]);

// People naturally type these as one word even though the catalogue titles
// use the spaced form. Keep this small and explicit so a typo cannot broaden
// every search into an expensive fuzzy query.
const TOKEN_ALIASES = new Map([
  ['ratelimit', ['rate', 'limit', 'limiter', 'limiting']],
  ['ratelimiter', ['rate', 'limit', 'limiter', 'limiting']],
  ['ratelimiting', ['rate', 'limit', 'limiter', 'limiting']],
]);

function normalizeQuery(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}

// PostgREST's `or` expression uses commas and periods as syntax. Keep the
// command bar query deliberately conservative so user text can never alter it.
function searchTerm(value) {
  return value.replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function searchTokens(value) {
  const rawTokens = value.toLocaleLowerCase().split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return [...new Set(rawTokens.flatMap((token) => [token, ...(TOKEN_ALIASES.get(token) ?? [])]))];
}

function orExpression(columns, tokens) {
  return tokens.flatMap((token) => columns.map((column) => `${column}.ilike.%${token}%`)).join(',');
}

function rankResult(result, query, tokens) {
  const title = result.title.toLocaleLowerCase();
  const text = [result.title, result.topic, result.subtopic, result.description, result.summary, ...(result.tags ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
  const tokenHits = tokens.filter((token) => text.includes(token)).length;
  const titleHits = tokens.filter((token) => title.includes(token)).length;
  const phrase = text.includes(query.toLocaleLowerCase());
  return (phrase ? 10_000 : 0) + tokenHits * 100 + titleHits * 25;
}

async function searchRows(table, fields, columns, tokens, configure) {
  let query = db.from(table).select(fields).or(orExpression(columns, tokens));
  query = configure(query);
  return unwrap(await query.limit(CANDIDATE_LIMIT), `search ${table}`);
}

function toSearchItem(row, type) {
  return {
    type,
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    topic: row.topic ?? null,
    subtopic: row.subtopic ?? null,
    difficulty: row.difficulty ?? null,
  };
}

/** Lightweight catalogue metadata for the client-side ⌘K index. */
export function getSearchIndex({ includeBlogs = true } = {}) {
  const key = `search:index:${includeBlogs ? 'pro' : 'free'}`;
  return getOrSetCached(key, INDEX_TTL_MS, async () => {
    const [problems, blogs] = await Promise.all([
      unwrap(
        await db.from('problems').select(INDEX_PROBLEM_FIELDS).order('order_index'),
        'load search problem index',
      ),
      includeBlogs
        ? unwrap(
          await db.from('blogs').select(INDEX_BLOG_FIELDS).eq('status', 'published').order('published_at', { ascending: false }),
          'load search blog index',
        )
        : Promise.resolve([]),
    ]);

    return {
      items: [
        ...problems.map((problem) => toSearchItem(problem, 'problem')),
        ...blogs.map((blog) => toSearchItem(blog, 'blog')),
      ],
    };
  });
}

/** Fast cross-catalogue search for the ⌘K command bar. */
export function searchContent(rawQuery, { includeBlogs = true } = {}) {
  const query = normalizeQuery(rawQuery);
  if (query.length < 2) return Promise.resolve({ items: [] });

  const key = `search:command:${includeBlogs ? 'pro' : 'free'}:${query.toLocaleLowerCase()}`;
  return getOrSetCached(key, SEARCH_TTL_MS, async () => {
    const term = searchTerm(query);
    const tokens = searchTokens(term);
    if (!tokens.length) return { items: [] };
    const [problems, blogs] = await Promise.all([
      searchRows('problems', SEARCH_FIELDS, ['title', 'topic', 'subtopic', 'description'], tokens,
        (query) => query.order('order_index')),
      includeBlogs
        ? searchRows('blogs', BLOG_FIELDS, ['title', 'summary', 'topic'], tokens,
          (query) => query.eq('status', 'published').order('published_at', { ascending: false }))
        : Promise.resolve([]),
    ]);

    const items = [
      ...problems.map((problem) => ({
        type: 'problem',
        id: problem.id,
        slug: problem.slug,
        title: problem.title,
        kind: problem.kind,
        topic: problem.topic,
        subtopic: problem.subtopic ?? null,
        difficulty: problem.difficulty,
        description: problem.description ?? '',
      })),
      ...blogs.map((blog) => ({
        type: 'blog',
        id: blog.id,
        slug: blog.slug,
        title: blog.title,
        kind: blog.kind,
        topic: blog.topic,
        subtopic: null,
        difficulty: blog.difficulty,
        summary: blog.summary ?? '',
        tags: blog.tags ?? [],
      })),
    ];

    return {
      items: items
        .sort((a, b) => rankResult(b, query, tokens) - rankResult(a, query, tokens) || a.title.localeCompare(b.title))
        .slice(0, RESULT_LIMIT * 2)
        .map(({ description: _description, summary: _summary, tags: _tags, ...item }) => item),
    };
  });
}
