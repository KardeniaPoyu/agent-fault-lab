import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { Runner } from './runner.mjs';
import { FaultEngine } from './engine.mjs';
import { SCENARIOS, configuration } from './catalog.mjs';
import { report } from './report.mjs';

const publicFiles = new Map([['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
const publicRun = ({ token, ...run }) => run;
async function readBody(req, raw = false) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) { const error = new Error('Body exceeds 1 MiB'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (raw) return buffer;
  if (!buffer.length) return {};
  try { const body = JSON.parse(buffer.toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new Error('Expected a JSON object'); }
}

export async function createLab({ dbPath = ':memory:', port = 0, host = '127.0.0.1', upstream } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('This local lab only binds to loopback');
  if (upstream && !['http:', 'https:'].includes(new URL(upstream).protocol)) throw new Error('Upstream must use HTTP(S)');
  const store = new Store(dbPath);
  for (const run of store.list()) if (run.status === 'running') {
    store.update(run.id, { status: 'interrupted', finishedAt: new Date().toISOString() });
    store.event(run.id, 'run.finished', { code: 'interrupted' });
  }
  const runner = new Runner(store);
  const engine = new FaultEngine(store, id => runner.kill(id));
  const sseClients = new Set();
  const inflight = new Set();
  const json = engine.json.bind(engine);
  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const hostHeader = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(hostHeader)) return json(res, 403, { error: 'Invalid Host' });
    if (req.headers.origin && req.headers.origin !== `http://${hostHeader}`) return json(res, 403, { error: 'Cross-origin requests are disabled' });
    const url = new URL(req.url, `http://${hostHeader}`);
    const path = url.pathname;
    if (req.method === 'GET' && publicFiles.has(path)) {
      const [file, mime] = publicFiles.get(path);
      const data = await readFile(fileURLToPath(new URL(`../public/${file}`, import.meta.url)));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' }); return res.end(data);
    }
    if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, version: '0.1.0', upstreamConfigured: Boolean(upstream), active: runner.active() });
    if (path === '/api/scenarios' && req.method === 'GET') return json(res, 200, SCENARIOS);
    if (path === '/api/runs' && req.method === 'GET') return json(res, 200, store.list().map(r => ({ ...publicRun(r), verdict: report(store, r.id).verdict })));
    if (path === '/api/runs' && req.method === 'POST') {
      const input = await readBody(req);
      if (input.strategy === 'external' && input.scenario === 'process-crash') return json(res, 400, { error: 'Use CLI supervise for process-crash; an HTTP client cannot be terminated by the lab' });
      const run = runner.create(input);
      return json(res, 201, { ...publicRun(run), ...(run.config.strategy === 'external' ? { token: run.token, toolBaseUrl: `${runner.baseUrl}/api/runs/${run.id}` } : {}) });
    }
    if (path === '/api/compare' && req.method === 'POST') {
      const input = await readBody(req); configuration(input);
      if (runner.active() > 2) return json(res, 409, { error: 'Comparison needs two available experiment slots' });
      const runs = ['naive', 'resilient'].map(strategy => runner.create({ ...input, strategy }));
      return json(res, 201, { runs: runs.map(publicRun) });
    }
    const match = path.match(/^\/api\/runs\/([a-f0-9-]{36})(?:\/(.*))?$/);
    if (!match) return json(res, 404, { error: 'Not found' });
    const [, id, tail = ''] = match;
    const run = store.run(id);
    if (!run) return json(res, 404, { error: 'Run not found' });
    if (req.method === 'GET' && (tail === '' || tail === 'report')) return json(res, 200, report(store, id));
    if (req.method === 'GET' && tail === 'export') {
      res.setHeader('Content-Disposition', `attachment; filename="agent-fault-lab-${id.slice(0, 8)}.json"`);
      return json(res, 200, report(store, id));
    }
    if (req.method === 'GET' && tail === 'events') {
      const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return json(res, 400, { error: 'Invalid event cursor' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = event => res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      for (const event of store.events(id, after)) send(event);
      const listener = (eventId, event) => { if (eventId === id) send(event); };
      store.on('event', listener); sseClients.add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref();
      req.on('close', () => { clearInterval(heartbeat); store.off('event', listener); sseClients.delete(res); });
      return;
    }
    if (req.method === 'POST' && tail === 'replay') {
      if (run.config.strategy === 'external') return json(res, 409, { error: 'External agents must be reconnected or supervised explicitly' });
      return json(res, 201, publicRun(runner.create(run.config)));
    }
    if (req.method === 'POST' && tail === 'cancel') { runner.finish(id, 'cancelled'); return json(res, 200, report(store, id)); }
    const token = String(req.headers['x-lab-token'] ?? '');
    if (token.length !== run.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(run.token))) return json(res, 401, { error: 'Missing or invalid X-Lab-Token' });
    if (run.status !== 'running') return json(res, 409, { error: 'Experiment is no longer running' });
    if (tail.startsWith('proxy/')) return engine.proxy(id, tail.slice(6) + url.search, await readBody(req, true), req, res, upstream);
    if (tail.startsWith('tools/') && req.method === 'POST') return engine.tool(id, tail.slice(6), await readBody(req), req, res);
    if (tail === 'checkpoint' && req.method === 'GET') return json(res, 200, store.checkpoint(id));
    if (tail === 'checkpoint' && req.method === 'POST') {
      const body = await readBody(req);
      if (!Array.isArray(body.completed) || body.completed.length > run.config.orders || body.completed.some(n => !Number.isInteger(n) || n < 1 || n > run.config.orders) || new Set(body.completed).size !== body.completed.length) return json(res, 400, { error: 'completed must contain unique valid order numbers' });
      store.saveCheckpoint(id, { completed: body.completed }); store.event(id, 'checkpoint.saved', { completed: body.completed }); return json(res, 200, { ok: true });
    }
    if (tail === 'agent-events' && req.method === 'POST') {
      const body = await readBody(req);
      if (!['agent.retry', 'agent.completed', 'agent.failed', 'agent.message_deduplicated', 'agent.checkpoint_restored'].includes(body.type)) return json(res, 400, { error: 'Unsupported agent event' });
      const detail = {};
      for (const key of ['tool', 'operation', 'code']) if (typeof body[key] === 'string') detail[key] = body[key].slice(0, 128);
      if (Number.isInteger(body.attempt)) detail.attempt = body.attempt;
      store.event(id, body.type, detail); return json(res, 200, { ok: true });
    }
    if (tail === 'complete' && req.method === 'POST' && run.config.strategy === 'external') { runner.finish(id, 'completed'); return json(res, 200, report(store, id)); }
    return json(res, 404, { error: 'Not found' });
  }
  const server = createServer((req, res) => {
    const task = handle(req, res).catch(error => json(res, error.status ?? 400, { error: error.message })).finally(() => inflight.delete(task));
    inflight.add(task);
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  runner.baseUrl = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  let closed = false;
  return { server, store, runner, url: runner.baseUrl, async close() {
    if (closed) return; closed = true;
    await runner.close();
    for (const res of sseClients) res.end();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...inflight]);
    store.close();
  } };
}
