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
  for (const name of ['problems', 'assessment_attempts', 'assessment_answers', 'assessment_questions', 'assessment_exposures', 'subscriptions', 'payment_webhook_events', 'streak_milestones', 'inactive_reminder_events', 'blog_bookmarks']) {
    assert.ok(tables.has(name), `${name} table missing`);
  }

  // A weighted LLD paper cannot be scored 0-10 in whole numbers.
  const scoreColumn = await database.query(`
    select data_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'assessment_attempts' and column_name = 'score'
  `);
  assert.equal(scoreColumn.rows[0].data_type, 'numeric');

  const attemptColumns = await database.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'assessment_attempts'
  `);
  const attemptColumnNames = new Set(attemptColumns.rows.map((row) => row.column_name));
  for (const column of ['blueprint', 'language', 'max_score']) {
    assert.ok(attemptColumnNames.has(column), `assessment_attempts.${column} missing`);
  }

  const answerColumns = await database.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'assessment_answers'
  `);
  const answerColumnNames = new Set(answerColumns.rows.map((row) => row.column_name));
  for (const column of ['language', 'source_code', 'run_count']) {
    assert.ok(answerColumnNames.has(column), `assessment_answers.${column} missing`);
  }

  // One question can only ever exist once per problem, however many times it is generated.
  const uniqueFingerprint = await database.query(`
    select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'assessment_questions_fingerprint_idx'
  `);
  assert.match(uniqueFingerprint.rows[0].indexdef, /UNIQUE/i);

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
