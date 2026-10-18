import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_API_PORT, DEMO_WEB_PORT, PROJECT_ROOT } from '../../scripts/lib/board-demo';

type CliRecord = { root: string; serverPids: { api: number; web: number } };
type CliRunner = {
  child: ReturnType<typeof spawn>;
  record(prefix: string): CliRecord | undefined;
  waitFor(prefix: string): Promise<CliRecord>;
  end(): Promise<number | null>;
  output(): string;
};
function runCli(args: string[] = []): CliRunner {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/board-demo.ts', ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, TURSO_DB_URL: 'libsql://must-not-be-used.invalid', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk: Buffer) => {
    output = `${output}${chunk}`.slice(-1_000_000);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const closed = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  const record = (prefix: string) =>
    output
      .split('\n')
      .filter((line) => line.startsWith(`${prefix} `))
      .flatMap((line) => {
        try {
          return [JSON.parse(line.slice(prefix.length + 1)) as CliRecord];
        } catch {
          return [];
        }
      })
      .at(-1);
  const waitFor = async (prefix: string) => {
    const deadline = Date.now() + 25_000;
    let result = record(prefix);
    while (!result) {
      if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) throw new Error(output);
      await delay(25);
      result = record(prefix);
    }
    return result;
  };
  const end = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`CLI shutdown timed out\n${output}`));
          }, 12_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const runner = { child, record, waitFor, end, output: () => output };
  runners.push(runner);
  return runner;
}
const runners: CliRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) {
    if (runner.child.exitCode === null && runner.child.signalCode === null) runner.child.kill('SIGTERM');
    await runner.end();
  }
});

describe('Board Lite demo process lifecycle', () => {
  it('help and rejected targets do not create a database or start servers', async () => {
    const help = runCli(['--help']);
    expect(await help.end()).toBe(0);
    expect(help.output()).toContain('Usage: pnpm board:demo');
    expect(help.record('BOARD_DEMO_SANDBOX')).toBeUndefined();
    const rejected = runCli(['--database=file:local.db']);
    expect(await rejected.end()).toBe(1);
    expect(rejected.output()).toContain('Unsupported demo option');
    expect(rejected.record('BOARD_DEMO_SANDBOX')).toBeUndefined();
  }, 30_000);

  for (const port of [DEMO_API_PORT, DEMO_WEB_PORT])
    it(`occupied port ${port} fails safely, cleans its data, and leaves the listener alone`, async () => {
      const blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, '127.0.0.1', () => resolve());
      });
      try {
        const runner = runCli();
        expect(await runner.end(), runner.output()).toBe(1);
        expect(runner.output()).toMatch(/EADDRINUSE|already in use/);
        expect(runner.output()).toContain('BOARD_DEMO_CLEANED');
        const sandbox = runner.record('BOARD_DEMO_SANDBOX');
        expect(sandbox).toBeTruthy();
        if (!sandbox) throw new Error('Missing sandbox startup record');
        await expect(stat(sandbox.root)).rejects.toHaveProperty('code', 'ENOENT');
        expect(blocker.listening).toBe(true);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    }, 30_000);

  it('SIGINT during startup stops only its children and removes its sandbox', async () => {
    const runner = runCli();
    const sandbox = await runner.waitFor('BOARD_DEMO_SANDBOX');
    runner.child.kill('SIGINT');
    expect(await runner.end(), runner.output()).toBe(0);
    expect(runner.output()).toContain('BOARD_DEMO_CLEANED');
    await expect(stat(sandbox.root)).rejects.toHaveProperty('code', 'ENOENT');
  }, 30_000);

  it('an unexpected server exit stops the other server and removes its sandbox', async () => {
    const runner = runCli();
    const ready = await runner.waitFor('BOARD_DEMO_READY');
    process.kill(ready.serverPids.api, 'SIGTERM');
    expect(await runner.end(), runner.output()).toBe(1);
    expect(runner.output()).toContain('BOARD_DEMO_CLEANED');
    expect(runner.output()).toContain('unexpectedly');
    await expect(stat(ready.root)).rejects.toHaveProperty('code', 'ENOENT');
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(DEMO_WEB_PORT, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }, 30_000);
});
