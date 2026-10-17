import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.argv.slice(2).some((arg) => arg !== '--')) throw new Error('No arguments or database targets are accepted');
const { runPropertyBoardBenchmark } = await import('./lib/property-board-benchmark');
const report = await runPropertyBoardBenchmark();
const output = path.join(await mkdtemp(path.join(tmpdir(), 'notes-property-board-metrics-')), 'metrics.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.info(
  JSON.stringify({ output, fixture: report.fixture, environment: report.environment, summary: report.summary }, null, 2)
);
