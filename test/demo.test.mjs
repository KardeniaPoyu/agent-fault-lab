import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, modelReport } from '../public/demo.mjs';
import { SCENARIOS } from '../src/catalog.mjs';
import { createLab } from '../src/server.mjs';
import { report } from '../src/report.mjs';
import { setTimeout as delay } from 'node:timers/promises';

for(const scenario of SCENARIOS) for(const strategy of ['naive','resilient']) test(`Browser model matches real engine: ${scenario.id}/${strategy}`, async()=>{
  const config={scenario:scenario.id,strategy,fault:{at:2}};
  const model=simulate(config), simulated=modelReport(model);
  const lab=await createLab();
  try{
    const run=lab.runner.create(config);
    while(lab.store.run(run.id).status==='running') await delay(25);
    const real=report(lab.store,run.id);
    assert.equal(simulated.verdict,real.verdict);
    for(const key of ['calls','faults','retries','restarts','duplicateEffects','charges','receipts','actualCents','deduplicated']) assert.equal(simulated.metrics[key],real.metrics[key],key);
    assert.equal(simulated.mode,'browser-simulation');
    assert.deepEqual(model.events,simulate(config).events);
  }finally{await lab.close();}
});
test('unreached faults and cancellation are not reported as success',()=>{
  const model=simulate({strategy:'resilient',fault:{at:50}});
  assert.equal(modelReport(model).verdict,'failed');
  const partial=modelReport(model,4,'cancelled');
  assert.equal(partial.verdict,'failed');
  assert.equal(partial.effects.length,1);
  assert.throws(()=>simulate({strategy:'external'}));
});
