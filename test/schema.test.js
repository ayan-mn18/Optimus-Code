import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('canonical schema applies cleanly and contains new product tables', async () => {
  const database = new PGlite();
  await database.exec('create role anon; create role authenticated; create role service_role;');
  const source = await fs.readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const schema = source.replace('create extension if not exists "pgcrypto";', '');
  await database.exec(schema);
  await database.exec(schema);
  const result = await database.query(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `);
  const tables = new Set(result.rows.map((row) => row.table_name));
  for (const name of ['problems', 'assessment_attempts', 'assessment_answers', 'subscriptions', 'payment_webhook_events', 'streak_milestones', 'inactive_reminder_events', 'blog_bookmarks']) {
    assert.ok(tables.has(name), `${name} table missing`);
  }

  const columns = await database.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'enrollments'
  `);
  const enrollmentColumns = new Set(columns.rows.map((row) => row.column_name));
  assert.ok(enrollmentColumns.has('dsa_target'));
  assert.ok(enrollmentColumns.has('lld_target'));
  assert.ok(enrollmentColumns.has('hld_target'));
  assert.equal(enrollmentColumns.has('daily_target'), false);

  const userColumns = await database.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'users'
  `);
  const userColumnNames = new Set(userColumns.rows.map((row) => row.column_name));
  assert.ok(userColumnNames.has('last_login_at'));
  assert.ok(userColumnNames.has('last_activity_at'));
  await database.close();
});
