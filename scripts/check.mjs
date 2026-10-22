import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(dir) {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${f.name}`;
    if (f.isDirectory()) await walk(path);
    else if (path.endsWith('.mjs')) { const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' }); if (result.status) process.exit(result.status); }
  }
}
for (const dir of ['src', 'public', 'examples', 'test', 'scripts']) await walk(dir);
console.log('Syntax checks passed.');
