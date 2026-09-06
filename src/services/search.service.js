import { db, unwrap } from '../lib/supabase.js';
import { getOrSetCached } from '../lib/cache.js';

const SEARCH_TTL_MS = 30_000;
const RESULT_LIMIT = 8;
const SEARCH_FIELDS = 'id, slug, title, kind, topic, subtopic, difficulty';
const BLOG_FIELDS = 'id, slug, title, kind, topic, difficulty';

function normalizeQuery(value) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}

// PostgREST's `or` expression uses commas and periods as syntax. Keep the
// command bar query deliberately conservative so user text can never alter it.
function searchTerm(value) {
  return value.replace(/[%,._()]/g, ' ').replace(/\s+/g, ' ').trim();
}

function rankResult(result, query) {
  const needle = query.toLocaleLowerCase();
  const title = result.title.toLocaleLowerCase();
  const topic = (result.topic ?? '').toLocaleLowerCase();
  return (title === needle ? 0 : title.startsWith(needle) ? 1 : topic.startsWith(needle) ? 2 : 3);
}

/** Fast cross-catalogue search for the ⌘K command bar. */
export function searchContent(rawQuery) {
  const query = normalizeQuery(rawQuery);
  if (query.length < 2) return Promise.resolve({ items: [] });

  const key = `search:command:${query.toLocaleLowerCase()}`;
  return getOrSetCached(key, SEARCH_TTL_MS, async () => {
    const term = searchTerm(query);
    const pattern = `%${term}%`;
    const [problems, blogs] = await Promise.all([
      unwrap(
        await db
          .from('problems')
          .select(SEARCH_FIELDS)
          .or(`title.ilike.${pattern},topic.ilike.${pattern},subtopic.ilike.${pattern}`)
          .order('order_index')
          .limit(RESULT_LIMIT),
        'search problems',
      ),
      unwrap(
        await db
          .from('blogs')
          .select(BLOG_FIELDS)
          .eq('status', 'published')
          .or(`title.ilike.${pattern},summary.ilike.${pattern},topic.ilike.${pattern}`)
          .order('published_at', { ascending: false })
          .limit(RESULT_LIMIT),
        'search blogs',
      ),
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
      })),
    ];

    return {
      items: items
        .sort((a, b) => rankResult(a, query) - rankResult(b, query) || a.title.localeCompare(b.title))
        .slice(0, RESULT_LIMIT * 2),
    };
  });
}
