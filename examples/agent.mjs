// A deliberately small real subprocess. Every tool operation uses HTTP.
import { setTimeout as delay } from 'node:timers/promises';

const url = process.env.LAB_URL;
const config = JSON.parse(process.env.LAB_CONFIG);
const safe = config.strategy === 'resilient';
const headers = { 'Content-Type': 'application/json', 'X-Lab-Token': process.env.LAB_TOKEN };
const api = async (path, body, timeout = 3000) => {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) { const error = new Error(`HTTP_${response.status}`); error.status = response.status; error.retryAfterMs = Number(response.headers.get('retry-after') ?? 0) * 1000; throw error; }
  return response.json();
};
const log = (type, detail) => api('/agent-events', { type, ...detail });
async function tool(tool, order) {
  const operation = `order-${order}:${tool}`;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const body = { operation, ...(safe ? { idempotencyKey: operation } : {}) };
      const result = await api(`/tools/${tool}`, body, config.requestTimeoutMs);
      if (!Array.isArray(result.deliveries) || result.deliveries.some(d => !d.messageId || d.value?.operation !== operation)) throw new Error('INVALID_RESPONSE');
      return result.deliveries;
    } catch (error) {
      if (attempt === config.maxAttempts || (safe && error.status && ![408, 429, 500, 502, 503, 504].includes(error.status))) throw error;
      const code = error.name === 'TimeoutError' ? 'TIMEOUT' : error instanceof SyntaxError ? 'INVALID_JSON' : error.status ? `HTTP_${error.status}` : 'CONNECTION_ERROR';
      await log('agent.retry', { tool, operation, attempt, code });
      await delay(safe ? Math.max(error.retryAfterMs ?? 0, Math.min(80 * 2 ** (attempt - 1), 640)) : 45);
    }
  }
}
try {
  const checkpoint = safe ? await api('/checkpoint') : { completed: [] };
  for (let order = 1; order <= config.orders; order++) {
    if (checkpoint.completed.includes(order)) { await log('agent.checkpoint_restored', { operation: `order-${order}` }); continue; }
    const deliveries = await tool('charge', order);
    const seen = new Set();
    for (const message of deliveries) {
      if (safe && seen.has(message.messageId)) { await log('agent.message_deduplicated', { operation: `order-${order}:receipt` }); continue; }
      seen.add(message.messageId);
      await tool('receipt', order);
    }
    if (safe) { checkpoint.completed.push(order); await api('/checkpoint', checkpoint); }
    await delay(70);
  }
  await log('agent.completed', {});
} catch {
  await log('agent.failed', { code: 'RETRY_BUDGET_EXHAUSTED' }).catch(() => {});
  process.exitCode = 1;
}
