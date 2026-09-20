import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { PGlite } from '@electric-sql/pglite';

// Never connect to local/production services, even when .env.local is present.
process.env.DB_DRIVER = 'native';
process.env.DATABASE_URL = 'postgresql://test:test@invalid.test/test';
process.env.JWT_ACCESS_SECRET = 'admin-tests-access-secret';
process.env.JWT_REFRESH_SECRET = 'admin-tests-refresh-secret';
process.env.DODO_PAYMENTS_API_KEY = '';
process.env.EMAIL_DELIVERY_ENABLED = 'false';

const [{ createApp }, { db }, { env }, cache, { signAccessToken }, { getProAccess }] = await Promise.all([
  import('../src/app.js'),
  import('../src/lib/supabase.js'),
  import('../src/config/env.js'),
  import('../src/lib/cache.js'),
  import('../src/lib/tokens.js'),
  import('../src/middleware/subscription.js'),
]);
const ADMIN_KEY = 'a'.repeat(64);
const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
let database;
let app;
let requestNumber = 0;

/** Exercise the real Express stack without opening sockets or requiring AWS. */
function request({ body = { email: 'solver@example.com' }, authorization = `Bearer ${ADMIN_KEY}`, url = '/api/admin/pro/grant', ip } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: ip ?? `10.0.0.${++requestNumber}` });
    const req = new IncomingMessage(socket);
    req.method = 'POST';
    req.url = url;
    const content = JSON.stringify(body);
    req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(content)) };
    if (authorization !== null) req.headers.authorization = authorization;
    const res = new ServerResponse(req);
    const timeout = setTimeout(() => reject(new Error('In-process request timed out')), 5_000);
    res.end = (data) => {
      clearTimeout(timeout);
      res.emit('finish');
      socket.destroy();
      try {
        resolve({ status: res.statusCode, headers: res.getHeaders(), body: JSON.parse(String(data)) });
      } catch (error) {
        reject(error);
      }
      return res;
    };
    app.handle(req, res, reject);
    req.push(content);
    req.push(null);
  });
}

const userRow = async () => (await database.query('select * from users where id = $1', [USER_ID])).rows[0];

async function addSubscription(status) {
  await database.query('insert into subscriptions (user_id, status) values ($1, $2)', [USER_ID, status]);
}

before(async () => {
  database = new PGlite();
  await database.exec(`
    create table users (
      id uuid primary key, email text unique not null, name text not null,
      password_hash text, billing_exempt boolean not null default false,
      updated_at timestamptz not null default '2026-01-01T00:00:00Z'
    );
    create table subscriptions (user_id uuid unique references users(id), status text not null);
  `);
  await db.pool.end();
  db.pool = {
    async query(sql, params) {
      const result = await database.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  env.isProd = true;
  app = createApp();
});

beforeEach(async (t) => {
  env.admin.apiKey = ADMIN_KEY;
  cache.invalidateCache('auth:user:');
  cache.invalidateCache('subscription:');
  await database.exec('truncate subscriptions, users;');
  await database.query(`
    insert into users (id, email, name, password_hash) values
      ($1, 'solver@example.com', 'Solver', 'private-hash'),
      ($2, 'another@example.com', 'Another Solver', 'other-private-hash')
  `, [USER_ID, OTHER_ID]);
  t.mock.method(console, 'info', () => {});
  t.mock.method(console, 'error', () => {});
});

after(async () => { await database?.close(); });

test('admin route grants permanent Pro only to the exact normalized email', async () => {
  const before = await userRow();
  const result = await request({ body: { email: '  SoLvEr@EXAMPLE.com  ' } });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.body, {
    user: { id: USER_ID, email: 'solver@example.com', name: 'Solver', billingExempt: true },
    access: 'pro', expiresAt: null, alreadyGranted: false, billingUnchanged: true,
  });
  const after = await userRow();
  assert.equal(after.billing_exempt, true);
  assert.deepEqual({ ...after, billing_exempt: before.billing_exempt, updated_at: before.updated_at }, before);
  assert.notEqual(after.updated_at.getTime(), before.updated_at.getTime());
  assert.equal((await database.query('select billing_exempt from users where id = $1', [OTHER_ID])).rows[0].billing_exempt, false);
  assert.equal((await database.query('select count(*) from subscriptions')).rows[0].count, 0);
  env.billing.enabled = true;
  try {
    assert.equal((await getProAccess(after)).allowed, true);
  } finally {
    env.billing.enabled = false;
  }
});

test('unauthenticated requests, user JWTs and wrong admin keys cannot touch the database', async (t) => {
  const query = t.mock.method(db.pool, 'query', () => { throw new Error('Unauthorized database access'); });
  for (const authorization of [null, 'Bearer wrong', `Bearer ${'b'.repeat(64)}`, `Basic ${ADMIN_KEY}`, `Bearer ${ADMIN_KEY} extra`, `Bearer ${signAccessToken({ id: USER_ID })}`]) {
    const response = await request({ authorization });
    assert.equal(response.status, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(query.mock.callCount(), 0);
});

test('admin keys in the URL or request body do not authorize upgrades', async () => {
  assert.equal((await request({ authorization: null, url: `/api/admin/pro/grant?key=${ADMIN_KEY}` })).status, 401);
  assert.equal((await request({ authorization: null, body: { email: 'solver@example.com', apiKey: ADMIN_KEY } })).status, 401);
  assert.equal((await userRow()).billing_exempt, false);
});

test('missing, weak or malformed server keys disable the endpoint without database access', async (t) => {
  const query = t.mock.method(db.pool, 'query', () => { throw new Error('Disabled admin database access'); });
  for (const key of ['', 'short-key', 'a'.repeat(257), 'a'.repeat(32) + ' space']) {
    env.admin.apiKey = key;
    assert.equal((await request()).status, 503);
  }
  assert.equal(query.mock.callCount(), 0);
});

test('invalid email, arrays and privilege fields are rejected before database access', async (t) => {
  const query = t.mock.method(db.pool, 'query', () => { throw new Error('Invalid-body database access'); });
  for (const body of [{}, { email: '' }, { email: 'not-email' }, { email: 42 }, { email: ['solver@example.com'] }, [{ email: 'solver@example.com' }], { email: 'solver@example.com', billing_exempt: true }, { email: `${'a'.repeat(255)}@example.com` }]) {
    assert.equal((await request({ body })).status, 400);
  }
  assert.equal(query.mock.callCount(), 0);
});

test('unknown addresses and SQL wildcard characters never match another user or create accounts', async () => {
  for (const email of ['missing@example.com', 'sol_er@example.com']) {
    assert.equal((await request({ body: { email } })).status, 404);
  }
  assert.equal((await request({ body: { email: '%@example.com' } })).status, 400);
  assert.equal((await database.query('select count(*) from users')).rows[0].count, 2);
  assert.equal((await userRow()).billing_exempt, false);
});

test('repeated grants are idempotent and audit only the actual change without secrets', async () => {
  assert.equal((await request()).body.alreadyGranted, false);
  const updatedAt = (await userRow()).updated_at;
  assert.equal((await request()).body.alreadyGranted, true);
  assert.deepEqual((await userRow()).updated_at, updatedAt);
  assert.equal(console.info.mock.callCount(), 1);
  const [, event] = console.info.mock.calls[0].arguments;
  assert.equal(JSON.parse(event).action, 'pro.granted');
  assert.equal(JSON.parse(event).userId, USER_ID);
  assert.equal(event.includes(ADMIN_KEY), false);
  assert.equal(event.includes('solver@example.com'), false);
});

test('concurrent grants are safe and only one request changes the account', async () => {
  const results = await Promise.all([request(), request()]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  assert.deepEqual(results.map((result) => result.body.alreadyGranted).sort(), [false, true]);
  assert.equal((await userRow()).billing_exempt, true);
  assert.equal(console.info.mock.callCount(), 1);
});

test('granting and repeat requests invalidate the entitlement caches', async () => {
  for (const alreadyGranted of [false, true]) {
    cache.setCached(`auth:user:${USER_ID}`, { billing_exempt: false }, 60_000);
    cache.setCached(`subscription:${USER_ID}`, null, 60_000);
    assert.equal((await request()).body.alreadyGranted, alreadyGranted);
    assert.equal(cache.getCached(`auth:user:${USER_ID}`), undefined);
    assert.equal(cache.getCached(`subscription:${USER_ID}`), undefined);
  }
});

test('active, paused, on-hold and pending billing blocks the grant without modifying either row', async () => {
  for (const status of ['active', 'pending', 'on_hold', 'paused']) {
    await database.exec('truncate subscriptions;');
    await addSubscription(status);
    const original = await userRow();
    const response = await request();
    assert.equal(response.status, 409);
    assert.equal(response.body.error.details.subscriptionStatus, status);
    assert.deepEqual(await userRow(), original);
    assert.deepEqual((await database.query('select * from subscriptions')).rows, [{ user_id: USER_ID, status }]);
  }
  assert.equal(console.info.mock.callCount(), 0);
});

test('ended subscriptions are preserved when granting complimentary access', async () => {
  for (const status of ['cancelled', 'failed', 'expired']) {
    await database.exec('truncate subscriptions; update users set billing_exempt = false;');
    await addSubscription(status);
    assert.equal((await request()).status, 200);
    assert.equal((await userRow()).billing_exempt, true);
    assert.deepEqual((await database.query('select * from subscriptions')).rows, [{ user_id: USER_ID, status }]);
  }
});

test('lookup, subscription-read and update failures never report a successful grant', async (t) => {
  const originalQuery = db.pool.query;
  for (const target of ['FROM "public"."users"', 'FROM "public"."subscriptions"', 'UPDATE "public"."users"']) {
    const query = t.mock.method(db.pool, 'query', async (sql, params) => {
      if (sql.includes(target)) throw new Error('Private database connection details');
      return originalQuery(sql, params);
    });
    const response = await request();
    assert.equal(response.status, 500);
    assert.equal(response.body.error.message, 'Something went wrong on our side');
    assert.equal((await userRow()).billing_exempt, false);
    assert.equal(console.info.mock.callCount(), 0);
    query.mock.restore();
  }
});

test('an email changed during the grant cannot receive access accidentally', async (t) => {
  const originalQuery = db.pool.query;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.startsWith('UPDATE "public"."users"')) {
      await database.query('update users set email = $1 where id = $2', ['changed@example.com', USER_ID]);
    }
    return originalQuery(sql, params);
  });
  assert.equal((await request()).status, 409);
  assert.equal((await userRow()).billing_exempt, false);
});

test('the admin rate limit also covers failed authentication attempts', async (t) => {
  const query = t.mock.method(db.pool, 'query', () => { throw new Error('Rate-limited database access'); });
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await request({ ip: '10.0.1.250', authorization: null })).status, 401);
  }
  const response = await request({ ip: '10.0.1.250' });
  assert.equal(response.status, 429);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(response.headers['retry-after']);
  assert.equal(query.mock.callCount(), 0);
});
