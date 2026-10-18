import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBenchmarkDiagnostics } from './lib/property-board-diagnostics';

if (process.argv.slice(2).some((arg) => arg !== '--')) throw new Error('No arguments or database targets are accepted');
// Enable for crash triage without adding database targets or changing the JSON stdout contract.
const diagnostic = createBenchmarkDiagnostics(process.env.PROPERTY_BOARD_BENCHMARK_DIAGNOSTICS === '1');
diagnostic({ phase: 'load-benchmark', state: 'start' });
const { runPropertyBoardBenchmark } = await import('./lib/property-board-benchmark');
diagnostic({ phase: 'load-benchmark', state: 'complete' });
const report = await runPropertyBoardBenchmark(undefined, diagnostic);
diagnostic({ phase: 'report-directory', state: 'start' });
const output = path.join(await mkdtemp(path.join(tmpdir(), 'notes-property-board-metrics-')), 'metrics.json');
diagnostic({ phase: 'report-directory', state: 'complete' });
diagnostic({ phase: 'serialize-report', state: 'start' });
const contents = `${JSON.stringify(report, null, 2)}\n`;
diagnostic({ phase: 'serialize-report', state: 'complete' });
diagnostic({ phase: 'write-report', state: 'start' });
await writeFile(output, contents, { mode: 0o600 });
diagnostic({ phase: 'write-report', state: 'complete' });
diagnostic({ phase: 'print-summary', state: 'start' });
console.info(
  JSON.stringify({ output, fixture: report.fixture, environment: report.environment, summary: report.summary }, null, 2)
);
diagnostic({ phase: 'print-summary', state: 'complete' });
