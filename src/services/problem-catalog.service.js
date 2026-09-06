import { db, unwrap } from '../lib/supabase.js';
import { getOrSetCached } from '../lib/cache.js';

const CATALOG_TTL_MS = 60_000;

function catalogKey({ fields, kind, topic, difficulty, orderBy }) {
  return `catalog:problems:${JSON.stringify({ fields, kind, topic, difficulty, orderBy })}`;
}

/**
 * Problem metadata changes rarely, but the catalogue is read on almost every
 * dashboard/challenge request. Keep a short-lived snapshot so those requests
 * do not each pay for a Supabase REST round trip.
 */
export function getProblemCatalog({ fields = '*', kind, topic, difficulty, orderBy = 'order_index' } = {}) {
  const key = catalogKey({ fields, kind, topic, difficulty, orderBy });
  return getOrSetCached(key, CATALOG_TTL_MS, async () => {
    let query = db.from('problems').select(fields);
    if (kind) query = query.eq('kind', kind);
    if (topic) query = query.eq('topic', topic);
    if (difficulty) query = query.eq('difficulty', difficulty);
    if (orderBy) query = query.order(orderBy);
    return unwrap(await query, 'load problem catalogue');
  });
}

export function getProblemById(problemId, fields = '*', kinds = null) {
  const kindKey = kinds?.join(',') ?? '';
  const key = `catalog:problem:${problemId}:${fields}:${kindKey}`;
  return getOrSetCached(key, CATALOG_TTL_MS, async () => {
    let query = db.from('problems').select(fields).eq('id', problemId);
    if (kinds?.length) query = query.in('kind', kinds);
    return unwrap(await query.maybeSingle(), 'load problem');
  });
}
