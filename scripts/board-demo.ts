import { setTimeout as delay } from 'node:timers/promises';
import {
  createDemoSandbox,
  DEMO_API_PORT,
  DEMO_BOARD_URL,
  DEMO_WEB_PORT,
  type DemoChild,
  type DemoSandbox,
  demoEnvironment,
  launchDemoChild,
  parseDemoArguments,
  readDemoCodes,
  stopDemoChild,
} from './lib/board-demo';
import { DEMO_USERS } from './lib/board-demo-seed';

async function watchCodes(sandbox: DemoSandbox, signal: AbortSignal) {
  const seen = new Set<string>();
  while (!signal.aborted) {
    for (const { id, ...code } of await readDemoCodes(sandbox)) {
      const key = `${id}:${code.otp}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`BOARD_DEMO_OTP ${JSON.stringify(code)}`);
      }
    }
    try {
      await delay(200, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

async function main() {
  const options = parseDemoArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      'Usage: pnpm board:demo [--large]\nFresh synthetic database every run. Ctrl+C cleans up; rerun to reset.\nNo external database targets, real data, email delivery, SST or deployment.'
    );
    return;
  }
  const controller = new AbortController();
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = () => {
      controller.abort();
      resolve();
    };
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const stopError = new Error('Demo stopped');
  const untilStopped = <T>(task: Promise<T>) =>
    Promise.race([
      task,
      stopped.then(() => {
        throw stopError;
      }),
    ]);
  const children: DemoChild[] = [];
  let sandbox: DemoSandbox | undefined;
  let codes: Promise<void> | undefined;
  let failure: unknown;
  try {
    sandbox = await createDemoSandbox(options.large);
    console.log(`BOARD_DEMO_SANDBOX ${JSON.stringify({ root: sandbox.root, databasePath: sandbox.databasePath })}`);
    if (controller.signal.aborted) throw stopError;
    const env = demoEnvironment(sandbox);
    const api = launchDemoChild(
      ['--import', 'tsx', 'src/api/dev.ts'],
      env,
      new RegExp(`API listening on http://127\\.0\\.0\\.1:${DEMO_API_PORT}`)
    );
    children.push(api);
    await untilStopped(api.ready);
    const web = launchDemoChild(
      ['--import', 'tsx', 'scripts/board-demo-web.ts'],
      env,
      new RegExp(`http://127\\.0\\.0\\.1:${DEMO_WEB_PORT}/`)
    );
    children.push(web);
    await untilStopped(
      Promise.race([
        web.ready,
        api.exited.then(() => {
          throw new Error('Demo API exited during frontend startup');
        }),
      ])
    );
    codes = watchCodes(sandbox, controller.signal);
    console.log(
      `\nBoard Lite demo: ${DEMO_BOARD_URL}\nSynthetic notes only. Board is read-only; the existing note editor still works.\nSign in with one of these emails, request a code, then copy BOARD_DEMO_OTP from this terminal:`
    );
    for (const [role, user] of Object.entries(DEMO_USERS)) console.log(`  ${role}: ${user.email}`);
    console.log(
      'Ctrl+C removes the temporary database and stops both servers. Rerun to reset; add --large for pagination.'
    );
    console.log(
      `BOARD_DEMO_READY ${JSON.stringify({ url: DEMO_BOARD_URL, root: sandbox.root, databasePath: sandbox.databasePath, counts: sandbox.counts, serverPids: { api: api.process.pid, web: web.process.pid } })}`
    );
    await untilStopped(
      Promise.race([
        codes.then(() => {
          if (!controller.signal.aborted) throw new Error('Demo OTP watcher stopped');
        }),
        ...children.map((child) =>
          child.exited.then(({ code, signal }) => {
            throw new Error(`Demo server stopped unexpectedly (${code ?? signal})`);
          })
        ),
      ])
    );
  } catch (error) {
    if (error !== stopError && !controller.signal.aborted) failure = error;
  } finally {
    controller.abort();
    // Stop server writers before closing/removing the owned database.
    const results = await Promise.allSettled(children.map(stopDemoChild));
    await codes?.catch(() => {});
    const stopFailure = results.find((result) => result.status === 'rejected');
    if (stopFailure?.status === 'rejected') {
      failure ??= stopFailure.reason;
      console.error('Could not stop all demo servers; temporary data was kept.');
    } else if (sandbox) {
      await sandbox
        .dispose()
        .then(() => console.log('BOARD_DEMO_CLEANED'))
        .catch((error: unknown) => {
          failure ??= error;
        });
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  if (failure !== undefined) throw failure;
}

void main().catch((error: unknown) => {
  console.error(`Board demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
