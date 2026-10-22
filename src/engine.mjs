import { setTimeout as delay } from 'node:timers/promises';

export class FaultEngine {
  constructor(store, killAgent) { this.store = store; this.killAgent = killAgent; }
  select(id, tool, operation) {
    const run = this.store.run(id);
    const ordinal = this.store.events(id).filter(e => e.type === 'tool.called' && e.tool === tool).length + 1;
    this.store.event(id, 'tool.called', { tool, operation, ordinal });
    const f = run.config.fault;
    if ((tool === f.tool || tool === 'proxy') && f.type !== 'none' && ordinal >= f.at && ordinal < f.at + f.count) return { ...f, ordinal };
    return null;
  }
  async inject(id, fault, req, res, result) {
    if (!fault) return false;
    this.store.event(id, 'fault.injected', { fault: fault.type, phase: fault.phase, ordinal: fault.ordinal });
    switch (fault.type) {
      case 'timeout': {
        // A real response delay: the client owns its deadline and cancellation.
        await delay(fault.delayMs);
        if (!res.destroyed && !res.writableEnded) this.json(res, 200, result);
        return true;
      }
      case 'disconnect': req.socket.destroy(); return true;
      case 'crash': {
        const killed = this.killAgent(id);
        this.store.event(id, killed ? 'agent.killed' : 'fault.unsupported', { code: killed ? 'PROCESS_TERMINATED' : 'NO_MANAGED_PROCESS' });
        req.socket.destroy();
        return true;
      }
      case 'rate_limit': res.setHeader('Retry-After', '1'); this.json(res, 429, { error: 'RATE_LIMITED', retryAfterMs: 1000 }); return true;
      case 'duplicate': this.json(res, 200, { deliveries: [result.deliveries[0], result.deliveries[0]] }); return true;
      case 'corrupt': res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"deliveries":['); return true;
      default: return false;
    }
  }
  json(res, status, data) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  async tool(id, tool, body, req, res) {
    if (!['charge', 'receipt'].includes(tool)) return this.json(res, 404, { error: 'Unknown tool' });
    const { operation, idempotencyKey, amount = tool === 'charge' ? 9900 : 0 } = body;
    if (typeof operation !== 'string' || !operation.length || operation.length > 128) return this.json(res, 400, { error: 'operation must contain 1–128 characters' });
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.length || idempotencyKey.length > 256)) return this.json(res, 400, { error: 'Invalid idempotencyKey' });
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000 || (tool === 'receipt' && amount !== 0)) return this.json(res, 400, { error: 'amount must be integer cents (0–100000000); receipts have zero amount' });
    const fault = this.select(id, tool, operation);
    if (fault?.phase === 'before' && await this.inject(id, fault, req, res, null)) return;
    let value;
    try { value = this.store.commit(id, { operation, key: idempotencyKey, tool, amount }); }
    catch (e) { if (e.message === 'IDEMPOTENCY_CONFLICT') return this.json(res, 409, { error: e.message }); throw e; }
    const result = { deliveries: [{ messageId: `${value.effectId}:result`, value }] };
    if (fault?.phase === 'after' && await this.inject(id, fault, req, res, result)) return;
    this.store.event(id, 'tool.returned', { tool, operation, effectId: value.effectId });
    this.json(res, 200, result);
  }
  async proxy(id, suffix, body, req, res, upstream) {
    if (!upstream) return this.json(res, 409, { error: 'Start the server with --upstream http://127.0.0.1:PORT to enable the proxy' });
    const run = this.store.run(id);
    if (run.config.fault.type === 'duplicate' && req.headers['x-lab-envelope'] !== '1') return this.json(res, 400, { error: 'Duplicate delivery requires X-Lab-Envelope: 1. See docs/ADAPTERS.md.' });
    this.store.update(id, { observationScope: 'proxy' });
    const fault = this.select(id, 'proxy', suffix.split('?')[0]);
    if (fault?.phase === 'before' && await this.inject(id, fault, req, res, null)) return;
    const target = new URL(upstream);
    // Prefix concatenation preserves a fixed authority; user paths cannot choose another host.
    target.pathname = target.pathname.replace(/\/$/, '') + '/' + suffix.split('?')[0].replace(/^\/+/, '');
    target.search = suffix.includes('?') ? suffix.slice(suffix.indexOf('?')) : '';
    const headers = {};
    for (const key of ['content-type', 'authorization', 'idempotency-key', 'accept']) if (req.headers[key]) headers[key] = req.headers[key];
    let response;
    let buffer;
    try {
      response = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const chunks = []; let length = 0;
      for await (const chunk of response.body ?? []) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');
        chunks.push(chunk);
      }
      buffer = Buffer.concat(chunks);
    } catch {
      this.store.event(id, 'proxy.error', { code: 'UPSTREAM_UNAVAILABLE' });
      return this.json(res, 502, { error: 'UPSTREAM_UNAVAILABLE' });
    }
    this.store.event(id, 'proxy.received', { code: String(response.status) });
    const envelope = { deliveries: [{ messageId: `proxy-${this.store.events(id).filter(e => e.type === 'proxy.received').length}`, value: { status: response.status, body: buffer.toString('utf8') } }] };
    if (fault?.phase === 'after') {
      if (fault.type === 'timeout') {
        this.store.event(id, 'fault.injected', { fault: fault.type, phase: fault.phase, ordinal: fault.ordinal });
        await delay(fault.delayMs);
      } else if (await this.inject(id, fault, req, res, envelope)) return;
    }
    if (res.destroyed || res.writableEnded) return;
    if (req.headers['x-lab-envelope'] === '1') return this.json(res, 200, envelope);
    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', ...(response.headers.has('retry-after') ? { 'Retry-After': response.headers.get('retry-after') } : {}) });
    res.end(buffer);
  }
}
