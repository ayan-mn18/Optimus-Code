import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_DRIVER = 'native';
process.env.DATABASE_URL = 'postgres://stub/stub';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';

const { PostgresClient } = await import('../src/lib/postgres.js');

test('native adapter attaches nested problem relations before hiding foreign keys', async () => {
  const client = new PostgresClient();
  const queries = [];
  client.pool = {
    query: async (sql, parameters) => {
      queries.push({ sql, parameters });
      if (sql.includes('FROM "public"."daily_assignments"')) {
        return {
          rows: [{ position: 0, round: 1, carried_over: false, problem_id: 'problem-1' }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM "public"."problems"')) {
        return { rows: [{ id: 'problem-1', title: 'Two Sum' }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await client
    .from('daily_assignments')
    .select('position, round, carried_over, problem:problems(id, title)')
    .eq('assigned_on', '2026-09-19');

  assert.equal(result.error, null);
  assert.deepEqual(result.data, [{
    position: 0,
    round: 1,
    carried_over: false,
    problem: { id: 'problem-1', title: 'Two Sum' },
  }]);
  assert.equal(queries.length, 2);
});
