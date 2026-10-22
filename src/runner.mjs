import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { configuration } from './catalog.mjs';

const agentPath = fileURLToPath(new URL('../examples/agent.mjs', import.meta.url));

export class Runner {
  constructor(store) { this.store = store; this.children = new Map(); this.deadlines = new Map(); this.closing = false; this.baseUrl = ''; }
  active() { return this.store.list().filter(r => r.status === 'running').length; }
  create(input, { command, args = [], cwd } = {}) {
    if (this.closing) throw new Error('Server is shutting down');
    if (this.active() >= 4) throw new Error('Maximum of 4 concurrent experiments');
    const config = configuration(input);
    const run = this.store.create({ id: randomUUID(), token: randomBytes(24).toString('hex'), config, status: 'running', createdAt: new Date().toISOString(), restarts: 0, managed: config.strategy !== 'external' || Boolean(command) });
    this.store.event(run.id, 'run.started', { strategy: config.strategy, seed: config.seed });
    const timer = setTimeout(() => this.finish(run.id, 'timed_out'), config.strategy === 'external' ? 120000 : 20000);
    timer.unref(); this.deadlines.set(run.id, timer);
    if (run.managed) this.launch(run.id, command ? { command, args, cwd } : null);
    return run;
  }
  launch(id, custom) {
    if (this.closing) return;
    const run = this.store.run(id);
    if (this.closing || run.status !== 'running') return;
    const env = { ...process.env, LAB_URL: `${this.baseUrl}/api/runs/${id}`, LAB_TOKEN: run.token, LAB_CONFIG: JSON.stringify(run.config) };
    const child = spawn(custom?.command ?? process.execPath, custom?.args ?? [agentPath], { env, cwd: custom?.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.set(id, child);
    this.store.event(id, run.restarts ? 'agent.restarted' : 'agent.started', { pid: child.pid ?? null, attempt: run.restarts + 1 });
    // Do not persist arbitrary stdout/stderr: an external agent may print credentials.
    child.stdout?.resume(); child.stderr?.resume();
    child.on('error', () => { this.store.event(id, 'agent.error', { code: 'SPAWN_FAILED' }); this.finish(id, 'failed'); });
    child.on('exit', (code, signal) => {
      if (this.children.get(id) === child) this.children.delete(id);
      const current = this.store.run(id);
      if (!current || current.status !== 'running' || this.closing) return;
      this.store.event(id, 'agent.exited', { code: code === 0 ? 'OK' : 'ABNORMAL', signal });
      if (code === 0) return this.finish(id, 'completed');
      if (current.restarts >= current.config.maxRestarts) return this.finish(id, 'failed');
      this.store.update(id, { restarts: current.restarts + 1 });
      setTimeout(() => this.launch(id, custom), 120).unref();
    });
  }
  kill(id) { const child = this.children.get(id); return child ? child.kill('SIGKILL') : false; }
  finish(id, status = 'completed') {
    const run = this.store.run(id);
    if (!run || run.status !== 'running') return;
    this.store.update(id, { status, finishedAt: new Date().toISOString() });
    this.store.event(id, 'run.finished', { code: status });
    clearTimeout(this.deadlines.get(id)); this.deadlines.delete(id);
    this.kill(id);
  }
  async close() {
    this.closing = true;
    const waits = [...this.children.values()].map(child => new Promise(resolve => { child.once('close', resolve); }));
    for (const run of this.store.list()) if (run.status === 'running') this.finish(run.id, 'interrupted');
    await Promise.all(waits);
  }
}
