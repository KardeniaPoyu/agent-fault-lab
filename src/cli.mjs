import { createLab } from './server.mjs';
import { report } from './report.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
const command = argv.shift() ?? 'serve';
const separator = argv.indexOf('--');
const childArgs = separator < 0 ? [] : argv.splice(separator).slice(1);
const options = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument: ${argv[i]}`);
  const key = argv[i].slice(2);
  options[key] = ['ci', 'json', 'help'].includes(key) ? true : argv[++i];
}
if (options.help || command === 'help') {
  console.log('Agent Fault Lab\n  npm start\n  node src/cli.mjs compare --scenario lost-response\n  node src/cli.mjs run --strategy resilient --scenario process-crash --ci\n  node src/cli.mjs replay --file report.json\n  node src/cli.mjs supervise --scenario process-crash -- python examples/external_agent.py\nOptions: --port 4318 --db .data/lab.sqlite --seed 42 --orders 3 --at 1 --count 1 --delay 900 --output report.json --upstream URL');
} else {
  let lab;
  try {
    if (!['serve', 'run', 'compare', 'replay', 'supervise'].includes(command)) throw new Error('Unknown command; use help');
    lab = await createLab({ port: Number(options.port ?? (command === 'serve' ? 4318 : 0)), dbPath: options.db ?? (command === 'serve' ? '.data/lab.sqlite' : ':memory:'), upstream: options.upstream });
    if (command === 'serve') {
      console.log(`Agent Fault Lab ready: ${lab.url}\nPress Ctrl+C to stop.`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await lab.close(); process.exit(0); });
    } else {
      const fault = {};
      for (const [flag, key] of [['at', 'at'], ['count', 'count'], ['delay', 'delayMs']]) if (options[flag] !== undefined) fault[key] = Number(options[flag]);
      let config = { scenario: options.scenario, strategy: options.strategy, seed: options.seed, ...(options.orders ? { orders: Number(options.orders) } : {}), fault };
      if (command === 'replay') {
        const saved = JSON.parse(await readFile(options.file, 'utf8'));
        config = saved.reproduction?.config ?? saved.config;
        if (!config || config.strategy === 'external') throw new Error('Replay requires a built-in agent report');
      }
      if (command === 'supervise' && !childArgs.length) throw new Error('Expected a command after --');
      const runs = command === 'compare' ? ['naive', 'resilient'].map(strategy => lab.runner.create({ ...config, strategy })) : [lab.runner.create({ ...config, ...(command === 'supervise' ? { strategy: 'external' } : {}) }, command === 'supervise' ? { command: childArgs[0], args: childArgs.slice(1) } : {})];
      while (runs.some(r => lab.store.run(r.id).status === 'running')) await delay(50);
      const reports = runs.map(r => report(lab.store, r.id));
      const output = reports.length === 1 ? reports[0] : reports;
      if (options.output) await writeFile(options.output, JSON.stringify(output, null, 2));
      if (options.json) console.log(JSON.stringify(output, null, 2));
      else for (const r of reports) console.log(`${r.run.config.strategy.padEnd(10)} ${r.verdict.toUpperCase()} | charges=${r.metrics.charges} duplicateEffects=${r.metrics.duplicateEffects} retries=${r.metrics.retries} restarts=${r.metrics.restarts}\n  fingerprint: ${r.fingerprint}`);
      if (options.ci && reports.some(r => r.verdict !== 'passed')) process.exitCode = 1;
      await lab.close();
    }
  } catch (error) { console.error(error.message); if (lab) await lab.close(); process.exitCode = 1; }
}
