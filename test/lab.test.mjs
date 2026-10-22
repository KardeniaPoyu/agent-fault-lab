import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLab } from '../src/server.mjs';
import { report } from '../src/report.mjs';
import { SCENARIOS, configuration } from '../src/catalog.mjs';
import { Store } from '../src/store.mjs';

async function wait(lab, id) {
  const start = Date.now();
  while (lab.store.run(id).status === 'running') { assert.ok(Date.now() - start < 25000); await delay(30); }
  return report(lab.store, id);
}
for (const scenario of SCENARIOS) for (const strategy of ['naive', 'resilient']) {
  test(`${scenario.id}: ${strategy}`, async () => {
    const lab = await createLab();
    try {
      const run = lab.runner.create({ scenario: scenario.id, strategy, fault: { at: 2 } });
      const r = await wait(lab, run.id);
      assert.equal(r.run.status, 'completed');
      const failure = strategy === 'naive' && ['lost-response', 'commit-disconnect', 'process-crash', 'duplicate-delivery', 'corrupt-response'].includes(scenario.id);
      assert.equal(r.verdict, failure ? 'failed' : 'passed');
      assert.equal(r.metrics.faults, scenario.count);
      if (scenario.id === 'process-crash') assert.equal(r.metrics.restarts, 1);
      assert.equal('token' in r.run, false);
    } finally { await lab.close(); }
  });
}
test('durable ledger deduplicates and rejects key reuse with different payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fault-lab-'));
  let store = new Store(join(dir, 'db.sqlite'));
  try {
    store.create({ id: 'test' });
    const value = { key: 'stable', operation: 'order-1:charge', tool: 'charge', amount: 9900 };
    store.commit('test', value); store.close(); store = new Store(join(dir, 'db.sqlite'));
    store.commit('test', value);
    assert.equal(store.effects('test').length, 1);
    assert.throws(() => store.commit('test', { ...value, amount: 1 }), /IDEMPOTENCY_CONFLICT/);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
test('seeded replay preserves semantic fingerprint', async () => {
  const lab = await createLab();
  try {
    const a = await wait(lab, lab.runner.create({ strategy: 'resilient' }).id);
    const b = await wait(lab, lab.runner.create(a.run.config).id);
    assert.equal(a.fingerprint, b.fingerprint);
  } finally { await lab.close(); }
});
test('validation, origin protection, token enforcement and cancellation', async () => {
  assert.throws(() => configuration({ orders: -1 }));
  const lab = await createLab();
  try {
    assert.equal((await fetch(lab.url + '/api/runs', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
    const run = lab.runner.create({ strategy: 'external', scenario: 'baseline' });
    assert.equal((await fetch(`${lab.url}/api/runs/${run.id}/tools/charge`, { method: 'POST', body: '{}' })).status, 401);
    lab.runner.finish(run.id, 'cancelled');
    assert.equal(report(lab.store, run.id).verdict, 'failed');
  } finally { await lab.close(); }
});
