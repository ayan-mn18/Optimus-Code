import { db, unwrap } from '../lib/supabase.js';
import { ApiError } from '../lib/errors.js';

const FIELDS = [
  'id', 'slug', 'title', 'kind', 'topic', 'subtopic', 'difficulty', 'description',
  'youtube_url', 'article_url', 'practice_url', 'source_url', 'resource_metadata',
  'assessment_enabled', 'coding_enabled', 'order_index',
].join(', ');

export async function listSystemDesign(user, { kind, topic, difficulty, status, search }) {
  let query = db.from('problems').select(FIELDS).eq('kind', kind).order('order_index');
  if (topic) query = query.eq('topic', topic);
  if (difficulty) query = query.eq('difficulty', difficulty);

  const [problems, solved] = await Promise.all([
    unwrap(await query, 'load System Design catalogue'),
    unwrap(
      await db
        .from('user_problems')
        .select('problem_id, solved_on')
        .eq('user_id', user.id)
        .eq('status', 'solved'),
      'load System Design progress',
    ),
  ]);
  const solvedMap = new Map(solved.map((row) => [row.problem_id, row.solved_on]));
  const term = search?.trim().toLocaleLowerCase();
  const items = problems
    .map((problem) => ({
      ...problem,
      solved: solvedMap.has(problem.id),
      solvedOn: solvedMap.get(problem.id) ?? null,
    }))
    .filter((problem) => !term || `${problem.title} ${problem.topic} ${problem.subtopic ?? ''}`.toLocaleLowerCase().includes(term))
    .filter((problem) => status === 'solved' ? problem.solved : status === 'unsolved' ? !problem.solved : true);

  const topics = [...problems.reduce((map, problem) => {
    const current = map.get(problem.topic) ?? { topic: problem.topic, total: 0, solved: 0 };
    current.total += 1;
    if (solvedMap.has(problem.id)) current.solved += 1;
    map.set(problem.topic, current);
    return map;
  }, new Map()).values()].sort((a, b) => a.topic.localeCompare(b.topic));

  return {
    kind,
    items,
    total: items.length,
    catalogTotal: problems.length,
    topics,
  };
}

export async function getSystemDesignProblem(user, problemId) {
  const [problem, solved] = await Promise.all([
    unwrap(
      await db.from('problems').select(FIELDS).eq('id', problemId).in('kind', ['LLD', 'HLD']).maybeSingle(),
      'load System Design problem',
    ),
    unwrap(
      await db
        .from('user_problems')
        .select('solved_on')
        .eq('user_id', user.id)
        .eq('problem_id', problemId)
        .eq('status', 'solved')
        .maybeSingle(),
      'load System Design solve state',
    ),
  ]);
  if (!problem) throw ApiError.notFound('System Design problem not found');
  return { ...problem, solved: Boolean(solved), solvedOn: solved?.solved_on ?? null };
}
