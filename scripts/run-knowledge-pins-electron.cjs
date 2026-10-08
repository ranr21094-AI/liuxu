const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.dirname(require.resolve('electron/package.json'));
const binary = path.join(root, 'dist', fs.readFileSync(path.join(root, 'path.txt'), 'utf8').trim());
const result = spawnSync(binary, [path.join(__dirname, 'knowledge-pins-electron-fixture.cjs')], { cwd: path.join(__dirname, '..'), stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
