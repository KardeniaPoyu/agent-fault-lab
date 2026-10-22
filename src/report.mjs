import { createHash } from 'node:crypto';

export function report(store, id) {
  const run = store.run(id);
  if (!run) return null;
  const effects = store.effects(id);
  const events = store.events(id);
  const groups = new Map();
  for (const e of effects) groups.set(e.operation, [...(groups.get(e.operation) ?? []), e]);
  const duplicates = [...groups.entries()].filter(([, v]) => v.length > 1).map(([operation, rows]) => ({ operation, count: rows.length, effectIds: rows.map(r => r.result.effectId) }));
  const charges = effects.filter(e => e.tool === 'charge');
  const receipts = effects.filter(e => e.tool === 'receipt');
  const missing = [];
  for (let i = 1; i <= run.config.orders; i++) for (const tool of ['charge', 'receipt']) {
    const op = `order-${i}:${tool}`;
    if (!groups.has(op)) missing.push(op);
  }
  const external = run.config.strategy === 'external';
  const terminal = !['running', 'queued'].includes(run.status);
  const assertions = [
    { id: 'fault-coverage', label: '计划中的故障全部触发', passed: events.filter(e => e.type === 'fault.injected').length === run.config.fault.count, detail: `${events.filter(e => e.type === 'fault.injected').length} / ${run.config.fault.count}` },
    { id: 'no-duplicates', label: '每个业务操作至多提交一次', passed: duplicates.length === 0, detail: `${duplicates.length} 个重复操作` },
    { id: 'completion', label: external ? '外部 Agent 报告完成' : '全部订单与回执完成', passed: run.status === 'completed' && (external || missing.length === 0), detail: external ? run.status : `${missing.length} 个缺失操作` },
    ...(!external ? [{ id: 'amount', label: '实际扣款等于预期扣款', passed: charges.reduce((s, e) => s + e.amount, 0) === run.config.orders * 9900, detail: `${charges.reduce((s, e) => s + e.amount, 0)} / ${run.config.orders * 9900} 分` }] : []),
    { id: 'bounded', label: '在监督器预算内退出', passed: !['timed_out', 'failed', 'interrupted', 'cancelled'].includes(run.status), detail: run.status }
  ];
  const semanticTrace = events.map(e => Object.fromEntries(['type', 'tool', 'operation', 'fault', 'phase', 'effectId', 'amount', 'code', 'attempt', 'ordinal'].filter(k => e[k] !== undefined).map(k => [k, e[k]])));
  const { token, ...safeRun } = run;
  const proxyOnly = run.observationScope === 'proxy';
  return {
    schemaVersion: 1, run: safeRun, assertions: proxyOnly ? [] : assertions, duplicates, missing: external ? [] : missing,
    observationScope: proxyOnly ? 'transport-only; upstream side effects are not observable' : 'sandbox-ledger',
    verdict: terminal ? (proxyOnly ? 'inconclusive' : assertions.every(a => a.passed) ? 'passed' : 'failed') : 'running',
    metrics: {
      calls: events.filter(e => e.type === 'tool.called').length,
      faults: events.filter(e => e.type === 'fault.injected').length,
      retries: events.filter(e => e.type === 'agent.retry').length,
      restarts: events.filter(e => e.type === 'agent.restarted').length,
      deduplicated: events.filter(e => e.type === 'effect.deduplicated').length,
      duplicateEffects: duplicates.reduce((n, d) => n + d.count - 1, 0),
      charges: charges.length, receipts: receipts.length,
      actualCents: charges.reduce((s, e) => s + e.amount, 0), expectedCents: external ? null : run.config.orders * 9900,
      elapsedMs: Math.max(0, Date.parse(run.finishedAt ?? new Date().toISOString()) - Date.parse(run.createdAt))
    },
    fingerprint: createHash('sha256').update(JSON.stringify({ config: run.config, trace: semanticTrace, effects: effects.map(({ run: _, key, ...r }) => r) })).digest('hex'),
    effects, events,
    reproduction: { schemaVersion: 1, config: run.config, command: `node src/cli.mjs run --scenario ${run.config.scenario} --strategy ${run.config.strategy} --seed ${JSON.stringify(run.config.seed)} --orders ${run.config.orders} --at ${run.config.fault.at} --count ${run.config.fault.count} --delay ${run.config.fault.delayMs}` }
  };
}
