const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electronDirectory = path.dirname(require.resolve('electron/package.json'));
const relative = fs.readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim();
const executable = path.join(electronDirectory, 'dist', relative);
if (!relative || !fs.existsSync(executable)) {
  process.stderr.write('Electron executable is not installed. Run npm install first.\n');
  process.exit(1);
}
const result = spawnSync(executable, [path.join(__dirname, 'note-browser-electron-fixture.cjs')], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
