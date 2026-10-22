import { SCENARIOS, configuration } from '../src/catalog.mjs';

// An explicitly labelled protocol model. No network, processes, or real tools.
export function simulate(input) {
  const config = configuration(input);
  if (config.strategy === 'external') throw new Error('外部 Agent 请使用本地版实验室');
  const safe = config.strategy === 'resilient';
  const events = [], effects = [], keys = new Map(), completed = new Set();
  let ordinal = 0, restarts = 0, status = 'completed', clock = 0;
  const event = (type, detail = {}) => events.push({ seq: events.length + 1, time: new Date(clock++ * 50).toISOString(), type, ...detail });
  event('run.started', { strategy: config.strategy, seed: config.seed });
  const call = (tool, order) => {
    const operation = `order-${order}:${tool}`;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      const n = tool === 'charge' ? ++ordinal : events.filter(e => e.type === 'tool.called' && e.tool === tool).length + 1;
      event('tool.called', { tool, operation, ordinal: n });
      const f = config.fault;
      const hit = tool === f.tool && f.type !== 'none' && n >= f.at && n < f.at + f.count;
      const inject = () => event('fault.injected', { fault: f.type, phase: f.phase, ordinal: n });
      let value;
      if (hit && f.phase === 'before') inject();
      else {
        value = safe && keys.get(operation);
        if (value) event('effect.deduplicated', value);
        else {
          value = { operation, tool, amount: tool === 'charge' ? 9900 : 0, effectId: `effect-${effects.length + 1}` };
          effects.push({ ...value, n: effects.length + 1, committedSeq: events.length + 1 });
          keys.set(operation, value); event('effect.committed', value);
        }
        if (hit) inject();
        if (hit && f.type === 'crash') { event('agent.killed', { code: 'PROCESS_TERMINATED' }); throw new Error('crash'); }
        if (hit && f.type === 'duplicate') return 2;
        if (!hit) { event('tool.returned', { tool, operation, effectId: value.effectId }); return 1; }
      }
      if (attempt === config.maxAttempts) throw new Error('exhausted');
      const code = { timeout: 'TIMEOUT', disconnect: 'CONNECTION_ERROR', rate_limit: 'HTTP_429', corrupt: 'INVALID_JSON' }[f.type];
      event('agent.retry', { tool, operation, attempt, code });
    }
  };
  for (;;) {
    event(restarts ? 'agent.restarted' : 'agent.started', { attempt: restarts + 1 });
    try {
      for (let order = 1; order <= config.orders; order++) {
        if (safe && completed.has(order)) { event('agent.checkpoint_restored', { operation: `order-${order}` }); continue; }
        const deliveries = call('charge', order);
        for (let n = 0; n < deliveries; n++) {
          if (safe && n > 0) event('agent.message_deduplicated', { operation: `order-${order}:receipt` });
          else call('receipt', order);
        }
        if (safe) { completed.add(order); event('checkpoint.saved', { completed: [...completed] }); }
      }
      event('agent.completed'); event('agent.exited', { code: 'OK' }); break;
    } catch (error) {
      if (error.message !== 'crash') event('agent.failed', { code: 'RETRY_BUDGET_EXHAUSTED' });
      event('agent.exited', { code: 'ABNORMAL' });
      if (restarts >= config.maxRestarts) { status = 'failed'; break; }
      restarts++;
    }
  }
  event('run.finished', { code: status });
  return { config, events, effects, status };
}

export function modelReport(model, visible = model.events.length, override) {
  const events = model.events.slice(0, visible);
  const effects = model.effects.filter(e => e.committedSeq <= visible);
  const status = override ?? (visible === model.events.length ? model.status : 'running');
  const groups = new Map();
  effects.forEach(e => groups.set(e.operation, [...(groups.get(e.operation) ?? []), e]));
  const duplicates = [...groups].filter(([,rows]) => rows.length > 1).map(([operation,rows]) => ({ operation, count: rows.length, effectIds: rows.map(r => r.effectId) }));
  const missing = [];
  for (let i = 1; i <= model.config.orders; i++) for (const tool of ['charge','receipt']) if (!groups.has(`order-${i}:${tool}`)) missing.push(`order-${i}:${tool}`);
  const count = type => events.filter(e => e.type === type).length;
  const actual = effects.reduce((sum,e) => sum + e.amount, 0), expected = model.config.orders * 9900;
  const assertions = [
    { id:'fault-coverage', label:'计划中的故障全部触发', passed:count('fault.injected') === model.config.fault.count },
    { id:'no-duplicates', label:'每个业务操作至多提交一次', passed:duplicates.length === 0 },
    { id:'completion', label:'全部订单与回执完成', passed:status === 'completed' && missing.length === 0 },
    { id:'amount', label:'实际扣款等于预期扣款', passed:actual === expected },
    { id:'bounded', label:'在监督器预算内退出', passed:!['failed','cancelled'].includes(status) }
  ];
  return { schemaVersion:1, mode:'browser-simulation', observationScope:'simulated-ledger',
    disclaimer:'浏览器协议模拟；未运行真实 Agent 进程、TCP 断连或远程工具。事件时间为逻辑时间。',
    run:{ id:model.id ?? 'model', config:model.config, status, createdAt:model.createdAt ?? new Date(0).toISOString() },
    verdict:status === 'running' ? 'running' : assertions.every(a=>a.passed) ? 'passed' : 'failed',
    metrics:{ calls:count('tool.called'), faults:count('fault.injected'), retries:count('agent.retry'), restarts:count('agent.restarted'), deduplicated:count('effect.deduplicated'), duplicateEffects:duplicates.reduce((n,d)=>n+d.count-1,0), charges:effects.filter(e=>e.tool==='charge').length, receipts:effects.filter(e=>e.tool==='receipt').length, actualCents:actual, expectedCents:expected },
    assertions, duplicates, missing, effects, events, reproduction:{ config:model.config, mode:'browser-simulation' }
  };
}

const runs = new Map(), listeners = new Map();
const storageKey = 'agent-fault-lab.demo.v1';
let archive = [];
try { const data = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '[]'); if (Array.isArray(data)) archive = data.filter(r => r.mode === 'browser-simulation' && r.run?.config && Array.isArray(r.events)).slice(0,30); } catch { /* Storage is optional. */ }
function persist(report) {
  archive = [report,...archive.filter(r=>r.run.id!==report.run.id)].slice(0,30);
  try { globalThis.localStorage?.setItem(storageKey,JSON.stringify(archive)); } catch { /* Private mode/quota: current session still works. */ }
}
function snapshot(id) { const state=runs.get(id); if(state) return modelReport(state.model,state.visible,state.override); const saved=archive.find(r=>r.run.id===id); if(!saved) throw new Error('演示记录不存在'); return saved; }
function start(config) {
  const model = { ...simulate(config), id:crypto.randomUUID(), createdAt:new Date().toISOString() };
  const state = { model, visible:0, timer:null };
  runs.set(model.id,state);
  state.timer=setInterval(()=>{
    state.visible++;
    if(state.visible>=model.events.length){clearInterval(state.timer);persist(snapshot(model.id));}
    for(const stream of listeners.get(model.id) ?? []) stream.onmessage?.({data:'{}'});
  },80);
  return snapshot(model.id).run;
}
export function createStream(id) {
  const stream={onmessage:null,close(){listeners.get(id)?.delete(stream);}};
  if(!listeners.has(id)) listeners.set(id,new Set()); listeners.get(id).add(stream);
  // Match SSE backlog delivery, including an experiment that completed before subscription.
  queueMicrotask(()=>stream.onmessage?.({data:'{}'})); return stream;
}
export async function api(path, body) {
  if(path==='/scenarios') return SCENARIOS.map(s=>({...s,description:'【模拟】'+s.description.replace('真实终止','模拟终止').replace('真实 HTTP','模拟 HTTP')}));
  if(path==='/runs') return [...new Map([...archive.map(r=>[r.run.id,r]), ...[...runs.keys()].map(id=>[id,snapshot(id)])]).values()].sort((a,b)=>b.run.createdAt.localeCompare(a.run.createdAt)).slice(0,30).map(r=>({...r.run,verdict:r.verdict}));
  if(path==='/compare') { configuration(body); if([...runs.values()].some(s=>!s.override&&s.visible<s.model.events.length)) throw new Error('请先结束当前演示'); return {runs:['naive','resilient'].map(strategy=>start({...body,strategy}))}; }
  const match=path.match(/^\/runs\/([^/]+)(?:\/(replay|cancel))?$/);
  if(!match) throw new Error('在线演示不提供后端 API，请运行本地版');
  const [,id,action]=match;
  if(action==='replay') return start(snapshot(id).run.config);
  if(action==='cancel') {const s=runs.get(id);if(s&&s.visible<s.model.events.length){clearInterval(s.timer);s.override='cancelled';persist(snapshot(id));}}
  return snapshot(id);
}
export function download(report) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`agent-fault-lab-simulation-${report.run.id.slice(0,8)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
