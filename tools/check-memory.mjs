import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['memory.js', 'context.js', 'agent-memo.js', 'agent.js', 'agent-tools.js', 'tool-router.js', 'app.js', 'build.mjs'];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: fs.readFileSync(path.join(root, 'app', file), 'utf8'), encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(file + ': syntax check failed');
    console.error(result.stderr);
    process.exit(1);
  }
}
console.log('Syntax OK: ' + files.length + ' files');
