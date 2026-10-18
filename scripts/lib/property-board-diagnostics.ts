import { writeSync } from 'node:fs';

export type BenchmarkDiagnosticEvent = {
  phase:
    | 'load-benchmark'
    | 'sandbox'
    | 'imports'
    | 'migrations'
    | 'seed'
    | 'capabilities'
    | 'board-reads'
    | 'filtered-reads'
    | 'query-plans'
    | 'report'
    | 'close-client'
    | 'cleanup-sandbox'
    | 'report-directory'
    | 'serialize-report'
    | 'write-report'
    | 'print-summary';
  state: 'start' | 'complete';
  scenario?: string;
  actor?: string;
  run?: number;
  view?: string;
  migration?: string;
};
export type BenchmarkDiagnostics = (event: BenchmarkDiagnosticEvent) => void;

export function createBenchmarkDiagnostics(enabled = false): BenchmarkDiagnostics {
  if (!enabled) return () => {};
  const started = performance.now();
  return (event) => {
    // Small synchronous stderr records survive native crashes; stdout stays machine-readable.
    // Callers supply phase/fixture labels only, never SQL, bindings, paths, credentials or note data.
    writeSync(
      process.stderr.fd,
      `PROPERTY_BOARD_BENCHMARK ${JSON.stringify({
        pid: process.pid,
        elapsedMs: Math.round(performance.now() - started),
        ...event,
      })}\n`
    );
  };
}
