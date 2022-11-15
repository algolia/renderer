import type express from 'express';

import type { GetListSuccess } from 'api/@types/getList';
import { tasksManager } from 'lib/singletons';

/**
 * List currently opened pages.
 * Useful to debug non-killed page.
 */
export function list(
  req: express.Request,
  res: express.Response<GetListSuccess>
): void {
  const open: { [engine: string]: string[] } = {
    chromium: [],
    firefox: [],
  };
  tasksManager.currentBrowsers.forEach((browser, engine) => {
    if (browser) {
      browser.instance!.contexts().forEach((ctx) => {
        ctx.pages().forEach((page) => {
          open[engine].push(page.url());
        });
      });
    }
  });

  res.status(200).json({ open });
}
