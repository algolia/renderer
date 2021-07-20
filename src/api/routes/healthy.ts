import type express from 'express';

import { isReady } from 'lib/helpers/isReady';
import renderer from 'lib/rendererSingleton';

let readyOnce = false;

export async function healthy(
  req: express.Request,
  res: express.Response
): Promise<void> {
  // The system cannot be checked for healthyness unless it has already started
  if (!readyOnce) {
    readyOnce = isReady();
  }
  if (!readyOnce) {
    res.status(200).send();
    return;
  }

  const isHealthy = renderer.ready && (await renderer.healthy());
  res.status(isHealthy ? 200 : 503).send();
}
