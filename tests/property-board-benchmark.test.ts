import { type ExecFileException, execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { benchmarkCandidates, runPropertyBoardBenchmark } from '../scripts/lib/property-board-benchmark';
import type { BenchmarkDiagnosticEvent } from '../scripts/lib/property-board-diagnostics';

const exec = promisify(execFile);

async function execNode(args: string[], env = process.env) {
  try {
    return await exec(process.execPath, args, { env, maxBuffer: 5_000_000 });
  } catch (cause) {
    const error = cause as ExecFileException & { stdout?: string; stderr?: string };
    throw new Error(
      `Node subprocess failed (exit code: ${error.code ?? 'none'}, signal: ${error.signal ?? 'none'}, killed: ${error.killed ?? false})\n${error.message}\nstdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`,
      { cause }
    );
  }
}

describe('owned local property board benchmark', () => {
  it('has exactly 1000 deterministic mostly-Done candidates and nonempty canvas representatives', () => {
    expect(benchmarkCandidates()).toEqual(benchmarkCandidates());
    expect(benchmarkCandidates()).toHaveLength(1000);
    expect(benchmarkCandidates().filter((n) => n.option === 'option_done')).toHaveLength(900);
    expect(benchmarkCandidates().filter((n) => n.documentType === 'canvas.default')).toHaveLength(10);
  });
  it('cleans a newly owned sandbox on injected failure before DB/service imports', async () => {
    let root = '';
    const events: BenchmarkDiagnosticEvent[] = [];
    await expect(
      runPropertyBoardBenchmark(
        (created) => {
          root = created;
          throw new Error('Injected failure');
        },
        (event) => events.push(event)
      )
    ).rejects.toThrow('Injected failure');
    expect(root).toContain('notes-property-board-benchmark-');
    await expect(stat(root)).rejects.toHaveProperty('code', 'ENOENT');
    expect(events).toEqual([
      { phase: 'sandbox', state: 'start' },
      { phase: 'sandbox', state: 'complete' },
      { phase: 'cleanup-sandbox', state: 'start' },
      { phase: 'cleanup-sandbox', state: 'complete' },
    ]);
  });
  it('runs real SQL with JSON capability, bounded exact pages, actual plans/counts/payload and no ambient remote target', async () => {
    const { stdout, stderr } = await execNode(['--import', 'tsx', 'scripts/benchmark-property-board.ts'], {
      ...process.env,
      TURSO_DB_URL: 'libsql://must-not-use.invalid',
      TURSO_AUTH_TOKEN: '',
      PROPERTY_BOARD_BENCHMARK_DIAGNOSTICS: '1',
    });
    const summary = JSON.parse(stdout);
    const report = JSON.parse(await readFile(summary.output, 'utf8'));
    try {
      const events = stderr
        .trim()
        .split('\n')
        .map((line) => {
          expect(line).toMatch(/^PROPERTY_BOARD_BENCHMARK /);
          return JSON.parse(line.slice('PROPERTY_BOARD_BENCHMARK '.length)) as BenchmarkDiagnosticEvent & {
            pid: number;
            elapsedMs: number;
          };
        });
      expect(events[0]).toMatchObject({ phase: 'load-benchmark', state: 'start', pid: expect.any(Number) });
      expect(events.at(-1)).toMatchObject({ phase: 'print-summary', state: 'complete' });
      const pending = new Set<string>();
      for (const [index, event] of events.entries()) {
        expect(event.pid).toBe(events[0].pid);
        expect(event.elapsedMs).toBeGreaterThanOrEqual(index ? events[index - 1].elapsedMs : 0);
        const key = JSON.stringify([event.phase, event.scenario, event.actor, event.run, event.view, event.migration]);
        if (event.state === 'start') {
          expect(pending.has(key)).toBe(false);
          pending.add(key);
        } else {
          expect(pending.delete(key)).toBe(true);
        }
      }
      expect(pending.size).toBe(0);
      expect(
        events
          .filter((event) =>
            [
              'report',
              'close-client',
              'cleanup-sandbox',
              'report-directory',
              'serialize-report',
              'write-report',
              'print-summary',
            ].includes(event.phase)
          )
          .map((event) => `${event.phase}:${event.state}`)
      ).toEqual([
        'report:start',
        'report:complete',
        'close-client:start',
        'close-client:complete',
        'cleanup-sandbox:start',
        'cleanup-sandbox:complete',
        'report-directory:start',
        'report-directory:complete',
        'serialize-report:start',
        'serialize-report:complete',
        'write-report:start',
        'write-report:complete',
        'print-summary:start',
        'print-summary:complete',
      ]);
      for (const phase of [
        'imports',
        'migrations',
        'seed',
        'capabilities',
        'board-reads',
        'filtered-reads',
        'query-plans',
      ])
        expect(events.some((event) => event.phase === phase && event.state === 'complete')).toBe(true);
      for (const secret of [
        'PROPERTY_BOARD_PRIVATE_BODY_SENTINEL',
        'PROPERTY_BOARD_PRIVATE_METADATA_SENTINEL',
        'PREVIEW_PRIVATE_SUFFIX',
        'libsql://must-not-use.invalid',
      ])
        expect(stderr).not.toContain(secret);
      expect(report.fixture.candidates).toBe(1000);
      expect(report.environment.jsonScalarExtraction).toBe(true);
      expect(report.fixture.typeBadges).toBe(375);
      expect(report.fixture.typeBadgesVerified).toBe(true);
      expect(report.fixture.typeLabels).toEqual([
        { id: 'type_bug', label: 'Defect' },
        { id: 'type_feature', label: 'Feature' },
        { id: 'type_task', label: 'Task' },
      ]);
      expect(report.summary.maxQueryCount).toBeLessThanOrEqual(9);
      expect(report.plans.some((p: { args: unknown[] }) => p.args.includes('$."property_type"'))).toBe(true);
      expect(report.plans.some((p: { args: unknown[] }) => !p.args.includes('$."property_type"'))).toBe(true);
      expect(report.samples).toHaveLength(320);
      expect(report.filtered.parity).toHaveLength(16);
      expect(report.filtered.maxQueryCount).toBeLessThanOrEqual(9);
      expect(report.filtered.samples.length).toBeGreaterThan(200);
      expect(
        report.filtered.parity.every(
          (p: { listIds: string[]; boardIds: string[] }) => JSON.stringify(p.listIds) === JSON.stringify(p.boardIds)
        )
      ).toBe(true);
      expect(
        report.filtered.parity
          .filter((p: { scenario: string }) => p.scenario === 'late-title')
          .every((p: { listIds: string[] }) => JSON.stringify(p.listIds) === JSON.stringify(['bench_0999']))
      ).toBe(true);
      expect(
        report.filtered.parity
          .filter((p: { scenario: string }) => p.scenario === 'hidden-text-after-preview')
          .every((p: { matches: number }) => p.matches === 1000)
      ).toBe(true);
      expect(report.filtered.samples.every((s: { rows: number }) => s.rows <= 25)).toBe(true);
      expect(report.filtered.plans.length).toBeGreaterThan(8);
      expect(
        report.filtered.plans.every((p: { plan: Array<{ detail: string }> }) =>
          p.plan.some((r) => /SEARCH notes USING INDEX/.test(r.detail))
        )
      ).toBe(true);
      expect(report.scenarios.map((s: { selected: number }) => s.selected)).toEqual([1, 0, 3, 12]);
      expect(report.scenarios.every((s: { maxQueryCount: number }) => s.maxQueryCount <= 9)).toBe(true);
      expect(
        report.samples.every(
          (s: { cards: number; transactionQueries: number }) => s.cards <= 25 && s.transactionQueries === 2
        )
      ).toBe(true);
      expect(report.plans.length).toBeGreaterThan(5);
      expect(
        report.plans.every(
          (p: { sql: string; plan: Array<{ detail: string }> }) =>
            p.sql.includes('left join "note_property_state"') &&
            p.plan.some((r) => /SEARCH notes USING INDEX/.test(r.detail))
        )
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain('PROPERTY_BOARD_PRIVATE_BODY_SENTINEL');
      expect(JSON.stringify(report)).not.toContain('PROPERTY_BOARD_PRIVATE_METADATA_SENTINEL');
      expect(report.scenarios[0].maxPayloadBytes).toBeLessThan(20000);
      expect(report.scenarios[1].maxPayloadBytes).toBeLessThan(20000);
      expect(report.scenarios[3].maxPayloadBytes).toBeGreaterThan(20000);
      expect(report.scenarios[3].maxPayloadBytes).toBeLessThan(350000);
    } finally {
      await rm(path.dirname(summary.output), { recursive: true });
    }
  }, 60000);
  it('keeps phase diagnostics opt-in and off JSON stdout', async () => {
    const { stdout, stderr } = await execNode([
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { createBenchmarkDiagnostics } from './scripts/lib/property-board-diagnostics.ts';
      createBenchmarkDiagnostics()({ phase: 'imports', state: 'start' });
      createBenchmarkDiagnostics(true)({ phase: 'seed', state: 'start' });
      console.log(JSON.stringify({ ok: true }));`,
    ]);
    expect(JSON.parse(stdout)).toEqual({ ok: true });
    const lines = stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^PROPERTY_BOARD_BENCHMARK /);
    expect(JSON.parse(lines[0].slice('PROPERTY_BOARD_BENCHMARK '.length))).toMatchObject({
      phase: 'seed',
      state: 'start',
      pid: expect.any(Number),
      elapsedMs: expect.any(Number),
    });
  });
  it('reports subprocess exit codes and captured output', async () => {
    await expect(
      execNode(['-e', 'console.log("diagnostic stdout"); console.error("diagnostic stderr"); process.exit(17)'])
    ).rejects.toThrow(/exit code: 17, signal: none[\s\S]*diagnostic stdout[\s\S]*diagnostic stderr/);
  });
  it.skipIf(process.platform === 'win32')('reports subprocess signals even without stderr', async () => {
    await expect(execNode(['-e', 'process.kill(process.pid, "SIGTERM")'])).rejects.toThrow(
      /exit code: none, signal: SIGTERM/
    );
  });
  it.skipIf(process.platform === 'win32')(
    'preserves the last synchronous phase marker on a subprocess signal',
    async () => {
      await expect(
        execNode([
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { createBenchmarkDiagnostics } from './scripts/lib/property-board-diagnostics.ts';
        createBenchmarkDiagnostics(true)({ phase: 'close-client', state: 'start' });
        process.kill(process.pid, 'SIGTERM');`,
        ])
      ).rejects.toThrow(/signal: SIGTERM[\s\S]*PROPERTY_BOARD_BENCHMARK[^\n]*"phase":"close-client","state":"start"/);
    }
  );
  it('refuses target arguments before sandbox allocation', async () => {
    await expect(
      execNode(['--import', 'tsx', 'scripts/benchmark-property-board.ts', 'libsql://forbidden.invalid'])
    ).rejects.toThrow('No arguments or database targets');
  });
});
