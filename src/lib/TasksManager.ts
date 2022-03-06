import { report } from 'helpers/errorReporting';
import { log as mainLog } from 'helpers/logger';
import { stats } from 'helpers/stats';

import { Browser } from './browser/Browser';
import { UNHEALTHY_TASK_TTL } from './constants';
import type { Task } from './tasks/Task';
import type { TaskObject, TaskFinal } from './types';

export const log = mainLog.child({ svc: 'mngr' });

export class TasksManager {
  #browser: Browser | null = null;
  #stopping: boolean = true;
  #tasks: Map<string, TaskObject> = new Map();
  #totalRun: number = 0;

  get healthy(): boolean {
    if (this.#stopping) {
      return false;
    }

    // Tasks lifecycle
    const lostTask: string[][] = [];
    this.#tasks.forEach((task) => {
      if (Date.now() - task.ref.createdAt!.getTime() > UNHEALTHY_TASK_TTL) {
        lostTask.push([task.ref.id, task.ref.params.url.href]);
      }
    });
    if (lostTask.length > 0) {
      report(new Error('Many lost tasks'), { lostTask });
      return false;
    }

    if (this.#browser) {
      return this.#browser.isReady;
    }

    return false;
  }

  get currentBrowser(): Browser | null {
    return this.#browser;
  }

  get currentConcurrency(): number {
    return this.#tasks.size;
  }

  get totalRun(): number {
    return this.#totalRun;
  }

  async launch(): Promise<void> {
    const browser = new Browser();
    await browser.create();

    this.#browser = browser;
    this.#stopping = false;
    log.info('Ready');
  }

  /**
   * Register and execute a task.
   */
  async task(task: Task): Promise<TaskFinal> {
    const promise = this.#exec(task);
    this.#totalRun += 1;
    this.#tasks.set(task.id, {
      ref: task,
      promise,
    });
    return await promise.finally(() => {
      this.#tasks.delete(task.id);
    });
  }

  /**
   * Actual execution of a task.
   * It will create a browser, a page, launch the task (render, login), close everything.
   * Any unexpected error will be thrown.
   */
  async #exec(task: Task): Promise<TaskFinal> {
    if (this.#stopping) {
      throw new Error('Task can not be executed: stopping');
    }
    if (!this.#browser) {
      throw new Error('Task can not be executed: no_browser');
    }

    const id = task.id;
    const url = task.params.url.href;
    const type = task.constructor.name;
    log.info('Processing', { id, url, type });

    const start = Date.now();

    try {
      await task.createContext(this.#browser);
      await task.process();
      await task.saveMetrics();
    } catch (err: any) {
      // Task itself should never break the whole execution
      report(err, { url });
    }

    // No matter what happen we want to kill everything gracefully
    try {
      await task.close();
      this.#tasks.delete(id);
    } catch (err) {
      report(new Error('Error during close'), { err, url });
    }

    // ---- Reporting
    const total = Date.now() - start;
    stats.timing('renderscript.task', total, undefined, { type });

    if (task.metrics.page) {
      const mp = task.metrics.page;
      /* eslint-disable prettier/prettier */
      stats.timing(`renderscript.task.download`, mp.timings.download!);
      stats.histogram(`renderscript.task.requests`, mp.requests.total);
      stats.increment(`renderscript.task.requests.amount`, mp.requests.total);
      stats.histogram(`renderscript.task.blockedRequests`, mp.requests.blocked);
      stats.increment(`renderscript.task.blockedRequests.amount`, mp.requests.blocked);
      /* eslint-enable prettier/prettier */
    }

    log.info('Done', { id, url });
    const res = task.results;
    return { ...res, timeout: task.page!.hasTimeout, metrics: task.metrics };
  }

  /**
   * Stop the task manager.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    log.info('[Manager] stopping...');

    // We wait for all tasks to finish before closing
    const promises: Array<Promise<void>> = [];
    this.#tasks.forEach((task) => {
      promises.push(this.#removeTask(task.ref.id));
    });
    await Promise.all(promises);

    this.#tasks.clear();

    if (this.#browser) {
      await this.#browser.stop();
      this.#browser = null;
    }
  }

  async #removeTask(id: string): Promise<void> {
    const task = this.#tasks.get(id);
    if (!task) {
      throw new Error(`Could not find task: ${id}`);
    }

    try {
      await task.promise;
    } catch (err) {
      //
    }
  }
}
