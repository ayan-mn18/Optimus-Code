import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

async function withServer(run) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('public health and pricing endpoints expose stable contracts', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.service, 'optimus-code');

    const pricing = await fetch(`${baseUrl}/api/billing/pricing`);
    assert.equal(pricing.status, 200);
    assert.deepEqual(await pricing.json(), {
      plans: {
        monthly: { amount: 10, currency: 'USD', interval: 'month' },
        annual: { amount: 80, currency: 'USD', interval: 'year' },
      },
    });
  });
});

test('private product routes reject anonymous requests', async () => {
  await withServer(async (baseUrl) => {
    const requests = [
      fetch(`${baseUrl}/api/system-design?kind=LLD`),
      fetch(`${baseUrl}/api/assessments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ problemId: '00000000-0000-0000-0000-000000000000' }),
      }),
      fetch(`${baseUrl}/api/billing/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'monthly' }),
      }),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 401]);
  });
});

test('billing webhook rejects unsigned payloads', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': 'webhook-test' },
      body: JSON.stringify({ type: 'subscription.active', data: {} }),
    });
    assert.ok([401, 503].includes(response.status));
  });
});
