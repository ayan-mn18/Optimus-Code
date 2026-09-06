/**
 * Small in-process TTL cache for read-heavy API data.
 *
 * Optimus currently runs as one API process, so this keeps hot reads off the
 * remote Supabase REST endpoint without introducing a new service. Values are
 * immutable snapshots from the caller's perspective; pending loads are shared
 * so a burst of identical requests produces one upstream query.
 */
const entries = new Map();
const MAX_ENTRIES = 500;

function evictIfNeeded() {
  if (entries.size < MAX_ENTRIES) return;
  const oldest = entries.keys().next().value;
  if (oldest) entries.delete(oldest);
}

export function getCached(key) {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCached(key, value, ttlMs) {
  evictIfNeeded();
  entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function invalidateCache(keyOrPrefix) {
  for (const key of entries.keys()) {
    if (key === keyOrPrefix || key.startsWith(keyOrPrefix)) entries.delete(key);
  }
}

export async function getOrSetCached(key, ttlMs, loader) {
  const cached = getCached(key);
  if (cached !== undefined) return cached;

  const pendingKey = `${key}:pending`;
  const pending = getCached(pendingKey);
  if (pending) return pending;

  const promise = Promise.resolve().then(loader).then((value) => {
    entries.delete(pendingKey);
    return setCached(key, value, ttlMs);
  }).catch((error) => {
    entries.delete(pendingKey);
    throw error;
  });
  setCached(pendingKey, promise, ttlMs);
  return promise;
}
