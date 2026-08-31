import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync(process.execPath, ['scripts/perf-baseline.mjs'], {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.status !== 0) process.exit(result.status || 1);

let report;
try { report = JSON.parse(result.stdout); } catch {
  process.stderr.write('性能基线未生成有效报告\n');
  process.exit(1);
}
const metrics = report.metrics || {};
const checks = {
  searchP95Ms: [metrics.searchP95Ms, 300],
  documentUpdateP95Ms: [metrics.documentUpdateP95Ms, 100],
  todoUpdateP95Ms: [metrics.todoUpdateP95Ms, 100],
};
const failures = Object.entries(checks)
  .filter(([, [value, target]]) => Number.isFinite(value) && value > target)
  .map(([name, [value, target]]) => `${name}=${value}ms (目标 ${target}ms)`);
if (failures.length && process.env.PERF_STRICT === '1') {
  process.stderr.write(`性能检查未达标：${failures.join('；')}\n`);
  process.exit(2);
}
if (failures.length) process.stdout.write(`性能提示（机器相关，未阻断）：${failures.join('；')}\n`);
