import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(projectRoot, 'electron');
const svgSource = path.join(electronDir, 'icon.svg');
const pngFallback = path.join(electronDir, 'icon.png');
const pngOutput = path.join(electronDir, 'icon-mac.png');
const icnsOutput = path.join(electronDir, 'icon.icns');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'liuxu-icon-'));

function run(command, args) {
  execFileSync(command, args, { stdio: 'ignore' });
}

function icnsChunk(type, png) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(png.length + header.length, 4);
  return Buffer.concat([header, png]);
}

function writeIcns(master) {
  const sizes = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const chunks = sizes.map(([type, size]) => {
    const resized = path.join(tempRoot, `${type}-${size}.png`);
    run('sips', ['-z', String(size), String(size), master, '--out', resized]);
    return icnsChunk(type, fs.readFileSync(resized));
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + header.length, 4);
  fs.writeFileSync(icnsOutput, Buffer.concat([header, body]));
}

try {
  let master = path.join(tempRoot, 'icon.svg.png');
  try {
    run('qlmanage', ['-t', '-s', '1024', '-o', tempRoot, svgSource]);
    if (!fs.existsSync(master)) throw new Error('Quick Look 未生成 PNG');
  } catch {
    master = path.join(tempRoot, 'icon-1024.png');
    run('sips', ['-z', '1024', '1024', pngFallback, '--out', master]);
  }
  fs.copyFileSync(master, pngOutput);
  writeIcns(master);
  console.log(`已生成 ${path.relative(projectRoot, pngOutput)} 和 ${path.relative(projectRoot, icnsOutput)}`);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
