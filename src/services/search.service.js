import { db, unwrap } from '../lib/supabase.js';
import { getOrSetCached } from '../lib/cache.js';

const SEARCH_TTL_MS = 30_000;
const RESULT_LIMIT = 8;
const CANDIDATE_LIMIT = 1_000;
const SEARCH_FIELDS = 'id, slug, title, kind, topic, subtopic, difficulty, description';
const BLOG_FIELDS = 'id, slug, title, kind, topic, difficulty, summary, tags';
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'design', 'do', 'explain', 'find', 'for',
  'how', 'i', 'in', 'is', 'me', 'of', 'or', 'please', 'show', 'the', 'to', 'what',
  'with', 'would', 'you',
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
  return [...new Set(value.toLocaleLowerCase().split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
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

/** Fast cross-catalogue search for the ⌘K command bar. */
export function searchContent(rawQuery) {
  const query = normalizeQuery(rawQuery);
  if (query.length < 2) return Promise.resolve({ items: [] });

  const key = `search:command:${query.toLocaleLowerCase()}`;
  return getOrSetCached(key, SEARCH_TTL_MS, async () => {
    const term = searchTerm(query);
    const tokens = searchTokens(term);
    if (!tokens.length) return { items: [] };
    const [problems, blogs] = await Promise.all([
      searchRows('problems', SEARCH_FIELDS, ['title', 'topic', 'subtopic', 'description'], tokens,
        (query) => query.order('order_index')),
      searchRows('blogs', BLOG_FIELDS, ['title', 'summary', 'topic'], tokens,
        (query) => query.eq('status', 'published').order('published_at', { ascending: false })),
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
