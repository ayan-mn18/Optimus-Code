import assert from 'node:assert/strict';
import test from 'node:test';
import { getCached, getOrSetCached, invalidateCache } from '../src/lib/cache.js';

test('cache coalesces concurrent loads and invalidates by prefix', async () => {
  const key = `test:cache:${Date.now()}`;
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: 42 };
  };

  const [first, second] = await Promise.all([
    getOrSetCached(key, 1_000, loader),
    getOrSetCached(key, 1_000, loader),
  ]);
  assert.strictEqual(loads, 1);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(getCached(key), { value: 42 });

  invalidateCache(key);
  assert.strictEqual(getCached(key), undefined);
});
