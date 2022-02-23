import type { Api } from 'api/index';
import type { TasksManager } from 'lib/TasksManager';

import * as reporting from './errorReporting';

interface Params {
  api: Api;
  tasksManager: TasksManager;
}

let gracefullyClosing = false;

async function close({ api, tasksManager }: Params): Promise<void> {
  const webServerPromise = new Promise<void>((resolve) => {
    console.info('[API] Shutting down');
    api.stop(() => {
      console.info('[API] Shut down');
      resolve();
    });
  });

  await webServerPromise;

  await tasksManager.stop();

  console.info('Gracefully stopped everything');
}

export async function gracefulClose(opts: Params): Promise<void> {
  // If we receive multiple signals, swallow them
  if (gracefullyClosing) {
    return;
  }

  gracefullyClosing = true;
  await close(opts);
  await reporting.drain();

  // eslint-disable-next-line no-process-exit
  process.exit(0);
}
