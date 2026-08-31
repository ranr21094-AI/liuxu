import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
let command;
let args;

if (process.platform === 'win32') {
  command = 'powershell.exe';
  args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(scriptDir, 'desktop-build.ps1'),
  ];
} else if (process.platform === 'darwin') {
  command = process.execPath;
  args = [path.join(scriptDir, 'desktop-build-mac.mjs'), '--adhoc'];
} else {
  throw new Error(`desktop:build 暂不支持 ${process.platform}`);
}

const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
