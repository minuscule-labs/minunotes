import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { benchmarkCandidates, runPropertyBoardBenchmark } from '../scripts/lib/property-board-benchmark';

const exec = promisify(execFile);

describe('owned local property board benchmark', () => {
  it('has exactly 1000 deterministic mostly-Done candidates and nonempty canvas representatives', () => {
    expect(benchmarkCandidates()).toEqual(benchmarkCandidates());
    expect(benchmarkCandidates()).toHaveLength(1000);
    expect(benchmarkCandidates().filter((n) => n.option === 'option_done')).toHaveLength(900);
    expect(benchmarkCandidates().filter((n) => n.documentType === 'canvas.default')).toHaveLength(10);
  });
  it('cleans a newly owned sandbox on injected failure before DB/service imports', async () => {
    let root = '';
    await expect(
      runPropertyBoardBenchmark((created) => {
        root = created;
        throw new Error('Injected failure');
      })
    ).rejects.toThrow('Injected failure');
    expect(root).toContain('notes-property-board-benchmark-');
    await expect(stat(root)).rejects.toHaveProperty('code', 'ENOENT');
  });
  it('runs real SQL with JSON capability, bounded exact pages, actual plans/counts/payload and no ambient remote target', async () => {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'scripts/benchmark-property-board.ts'], {
      env: { ...process.env, TURSO_DB_URL: 'libsql://must-not-use.invalid', TURSO_AUTH_TOKEN: '' },
      maxBuffer: 5_000_000,
    });
    const summary = JSON.parse(stdout);
    const report = JSON.parse(await readFile(summary.output, 'utf8'));
    try {
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
  it('refuses target arguments before sandbox allocation', async () => {
    await expect(
      exec(process.execPath, ['--import', 'tsx', 'scripts/benchmark-property-board.ts', 'libsql://forbidden.invalid'])
    ).rejects.toThrow('No arguments or database targets');
  });
});
