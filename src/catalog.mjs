export const SCENARIOS = [
  { id: 'lost-response', title: '扣款成功，响应消失', subtitle: 'The ambiguous commit', icon: '◷', type: 'timeout', phase: 'after', tool: 'charge', count: 1, description: '账本已经提交，但响应延迟超过 Agent 的等待期限。一次看似无害的重试，会不会变成第二次扣款？', lesson: '超时不等于失败。用稳定的幂等键查询或重试同一次操作。', tags: ['超时', '重复扣款'], severity: 'critical' },
  { id: 'network-partition', title: '网络突然中断', subtitle: 'A broken connection', icon: '⌁', type: 'disconnect', phase: 'before', tool: 'charge', count: 2, description: '连续两次关闭工具连接，模拟短暂的网络分区，检查有界重试与退避。', lesson: '区分可重试故障；指数退避应有上限，也应有退出条件。', tags: ['断网', '重试'], severity: 'warning' },
  { id: 'commit-disconnect', title: '提交后连接断开', subtitle: 'Committed, then disconnected', icon: '↯', type: 'disconnect', phase: 'after', tool: 'charge', count: 1, description: '提交副作用后直接销毁 TCP 连接。客户端只能看到连接错误，无法从错误判断提交结果。', lesson: '传输失败无法证明业务失败，幂等性必须由服务端持久化保证。', tags: ['断连', '不确定结果'], severity: 'critical' },
  { id: 'process-crash', title: 'Agent 在提交后崩溃', subtitle: 'The checkpoint gap', icon: '⏻', type: 'crash', phase: 'after', tool: 'charge', count: 1, description: '真实终止实验室管理的 Agent 子进程，再由监督器重启。检查检查点缺口是否造成重复操作。', lesson: '检查点与远程副作用无法天然原子提交；稳定操作标识跨重启依然必需。', tags: ['进程崩溃', '检查点'], severity: 'critical' },
  { id: 'duplicate-delivery', title: '同一个结果送达两次', subtitle: 'At-least-once delivery', icon: '⧉', type: 'duplicate', phase: 'after', tool: 'charge', count: 1, description: '工具响应的 deliveries 数组中放入两份相同消息，检查下游回执是否重复发出。', lesson: '消费端去重与下游幂等，缺一不可。HTTP 不会凭空变成两次响应。', tags: ['重复返回', '消息去重'], severity: 'warning' },
  { id: 'rate-limit', title: '工具拒绝服务', subtitle: 'Respect the backpressure', icon: '≋', type: 'rate_limit', phase: 'before', tool: 'charge', count: 2, description: '返回两次真实 HTTP 429 和 Retry-After，观察 Agent 是否恢复并避免无限重试。', lesson: '尊重 Retry-After，在有限的重试预算内退避。', tags: ['429', '退避'], severity: 'warning' },
  { id: 'corrupt-response', title: '结果格式被破坏', subtitle: 'A poisoned response', icon: '⌘', type: 'corrupt', phase: 'after', tool: 'charge', count: 1, description: '操作已完成，返回截断的 JSON。检查解析错误触发的重试是否重复产生副作用。', lesson: '解析失败也可能发生在提交之后，仍需端到端幂等。', tags: ['坏 JSON', '重试'], severity: 'critical' },
  { id: 'baseline', title: '无故障基线', subtitle: 'The control experiment', icon: '✓', type: 'none', phase: 'before', tool: 'charge', count: 0, description: '运行同样的订单流程，不注入任何故障，确认对照组正常。', lesson: '先证明基线能工作，再讨论故障恢复。', tags: ['对照组'], severity: 'normal' }
];

export function seedNumber(seed) {
  let n = 2166136261;
  for (const c of String(seed)) n = Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0;
  return n;
}

export function configuration(input = {}) {
  const scenario = SCENARIOS.find(s => s.id === (input.scenario ?? 'lost-response'));
  if (!scenario) throw new Error('Unknown scenario');
  const strategy = input.strategy ?? 'naive';
  if (!['naive', 'resilient', 'external'].includes(strategy)) throw new Error('Unknown strategy');
  const seed = String(input.seed ?? '42');
  if (!seed.length || seed.length > 64) throw new Error('Seed must contain 1–64 characters');
  const integer = (value, fallback, min, max, name) => {
    const n = value ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return n;
  };
  const orders = integer(input.orders, 3, 1, 10, 'orders');
  const fault = input.fault ?? {};
  if (typeof fault !== 'object' || Array.isArray(fault) || fault === null) throw new Error('fault must be an object');
  return {
    scenario: scenario.id, strategy, seed, orders,
    fault: {
      type: scenario.type, phase: scenario.phase, tool: 'charge',
      at: integer(fault.at, seedNumber(seed) % orders + 1, 1, 50, 'fault.at'),
      count: integer(fault.count, scenario.count, scenario.type === 'none' ? 0 : 1, scenario.type === 'none' ? 0 : 8, 'fault.count'),
      delayMs: integer(fault.delayMs, 900, 650, 5000, 'fault.delayMs')
    },
    requestTimeoutMs: 450, maxAttempts: 5, maxRestarts: 2
  };
}
