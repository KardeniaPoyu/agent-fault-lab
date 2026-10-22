import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLab } from '../src/server.mjs';
import { report } from '../src/report.mjs';

test('fixed upstream proxy forwards requests, injects duplicate envelope, and reports inconclusive', async () => {
  let calls = 0;
  const upstream = createServer((req, res) => { calls++; assert.equal(req.headers['x-lab-token'], undefined); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ path: req.url })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const lab = await createLab({ upstream: `http://127.0.0.1:${upstream.address().port}/tools` });
  try {
    const run = lab.runner.create({ strategy: 'external', scenario: 'duplicate-delivery', fault: { at: 1 } });
    const response = await fetch(`${lab.url}/api/runs/${run.id}/proxy/echo?q=1`, { headers: { 'X-Lab-Token': run.token, 'X-Lab-Envelope': '1' } });
    const result = await response.json();
    assert.equal(result.deliveries.length, 2);
    assert.deepEqual(result.deliveries[0], result.deliveries[1]);
    assert.equal(JSON.parse(result.deliveries[0].value.body).path, '/tools/echo?q=1');
    assert.equal(calls, 1);
    lab.runner.finish(run.id);
    assert.equal(report(lab.store, run.id).verdict, 'inconclusive');
  } finally { await lab.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('SSE resumes from cursor and excludes already delivered events', async () => {
  const lab = await createLab();
  const controller = new AbortController();
  try {
    const run = lab.runner.create({ strategy: 'external', scenario: 'baseline' });
    lab.store.event(run.id, 'agent.retry', { attempt: 1 });
    const response = await fetch(`${lab.url}/api/runs/${run.id}/events?after=1`, { signal: controller.signal });
    const reader = response.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /id: 2/);
    assert.doesNotMatch(text, /run.started/);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally { controller.abort(); await lab.close(); }
});

test('concurrent calls with the same key commit exactly one sandbox effect', async () => {
  const lab = await createLab();
  try {
    const run = lab.runner.create({ strategy: 'external', scenario: 'baseline' });
    const call = () => fetch(`${lab.url}/api/runs/${run.id}/tools/charge`, { method: 'POST', headers: { 'X-Lab-Token': run.token }, body: JSON.stringify({ operation: 'same', idempotencyKey: 'stable' }) }).then(r => r.json());
    const results = await Promise.all(Array.from({ length: 10 }, call));
    assert.equal(new Set(results.map(r => r.deliveries[0].value.effectId)).size, 1);
    assert.equal(lab.store.effects(run.id).length, 1);
  } finally { await lab.close(); }
});
