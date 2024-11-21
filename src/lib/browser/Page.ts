import type { BrowserContext, Page, Route, Response } from 'playwright';

import { report } from '../../helpers/errorReporting';
import { log } from '../../helpers/logger';
import {
  promiseWithTimeout,
  PromiseWithTimeoutError,
} from '../../helpers/promiseWithTimeout';
import { stats } from '../../helpers/stats';
import { DATA_REGEXP, IGNORED_RESOURCES } from '../constants';
import { cleanErrorMessage } from '../helpers/errors';
import { isURLAllowed } from '../helpers/validateURL';
import { adblocker } from '../singletons';
import type { PageMetrics, Perf, TaskBaseParams } from '../types';

import type { BrowserEngine } from './Browser';
import { DEFAULT_ENGINE } from './Browser';
import {
  METRICS_IGNORED_ERRORS,
  REQUEST_IGNORED_ERRORS,
  RESPONSE_IGNORED_ERRORS,
} from './constants';

/**
 * Abstract some logics around playwright pages.
 */
export class BrowserPage {
  #ref: Page | undefined;
  #context: BrowserContext | undefined;
  #engine: BrowserEngine;
  #metrics: PageMetrics = {
    timings: {
      download: 0,
    },
    requests: {
      total: 0,
      blocked: 0,
      pending: 0,
    },
    contentLength: {
      main: 0,
      total: 0,
    },
    mem: {
      jsHeapUsedSize: null,
      jsHeapTotalSize: null,
    },
  };
  #redirection?: string;
  #hasTimeout: boolean = false;
  #initialResponse?: Response;

  get ref(): Page | undefined {
    return this.#ref;
  }

  get context(): BrowserContext | undefined {
    return this.#context;
  }

  get isReady(): boolean {
    return Boolean(this.#ref && this.#context);
  }

  get isClosed(): boolean {
    return this.#ref?.isClosed() === true;
  }

  get hasTimeout(): boolean {
    return this.#hasTimeout;
  }

  get redirection(): string | undefined {
    return this.#redirection;
  }

  get initialResponse(): Response | undefined {
    return this.#initialResponse;
  }

  get pendingRequests(): number {
    return this.#metrics.requests.pending;
  }

  constructor(context: BrowserContext, engine?: BrowserEngine) {
    this.#context = context;
    this.#engine = engine || DEFAULT_ENGINE;
  }

  /**
   * Create an empty page in a browser.
   */
  async create(): Promise<void> {
    const start = Date.now();
    const page = await this.#context!.newPage();

    stats.timing('renderscript.page.create', Date.now() - start);
    this.#ref = page;

    page.on('crash', () => {
      // e.g: crash happen on OOM.
      report(new Error('Page crashed'), { pageUrl: page.url() });
    });
    page.on('popup', () => {
      report(new Error('Popup created'), { pageUrl: page.url() });
    });
    page.on('request', (req) => {
      log.debug('request_start', { url: req.url(), pageUrl: page.url() });
      this.#metrics.requests.pending += 1;
    });
    page.on('requestfailed', (req) => {
      log.debug('request_failed', { url: req.url(), pageUrl: page.url() });
      this.#metrics.requests.pending -= 1;
    });
    page.on('requestfinished', async (req) => {
      if (log.isLevelEnabled('trace')) {
        const response = await req.response();
        log.trace('request_finished', {
          url: req.url(),
          pageUrl: page.url(),
          requestHeaders: req.headers(),
          responseStatus: response?.status(),
        });
      } else if (log.isLevelEnabled('debug')) {
        const response = await req.response();
        log.debug('request_finished', {
          url: req.url(),
          pageUrl: page.url(),
          responseStatus: response?.status(),
        });
      }
      this.#metrics.requests.pending -= 1;
    });
  }

  /**
   * Destroy the page and the private context.
   */
  async close(): Promise<void> {
    await this.#ref?.close();
    this.#ref = undefined;
  }

  /**
   * We wrap goto to handle timeout.
   */
  async goto(
    url: string,
    opts: Parameters<Page['goto']>[1]
  ): Promise<Response> {
    let response: Response | null = null;

    function onResponse(res: Response): void {
      // We listen to response because "goto" will throw on timeout but we still want to process the doc in that case
      if (!response) {
        response = res;
      }
    }
    this.#ref!.once('response', onResponse);

    const start = Date.now();
    try {
      // Response can be assigned here or on('response')
      response = await this.#ref!.goto(url, opts);
    } catch (err: any) {
      if (!this.redirection && !err.message.includes('ERR_ABORTED')) {
        this.throwIfNotTimeout(err);
      }
    } finally {
      // We remove listener, because we don't want more response
      this.#ref!.removeListener('response', onResponse);
    }

    stats.timing('renderscript.page.goto', Date.now() - start, undefined, {
      success: response ? 'true' : 'false',
      waitUntil: opts?.waitUntil || 'unknown',
    });

    if (!response) {
      // Can happen in case of chrome crash
      throw new Error('goto_no_response');
    }

    return response;
  }

  /**
   * Wait for navigation with timeout handling.
   */
  async waitForNavigation(opts: {
    timeout: number;
    waitUntil: Parameters<Page['waitForLoadState']>[0];
  }): Promise<Response | null> {
    let response: Response | null = null;
    function onResponse(res: Response): void {
      // We listen to response because "goto" will throw on timeout but we still want to process the doc in that case
      if (!response) {
        response = res;
      }
    }
    this.#ref!.once('response', onResponse);

    try {
      if (this.#ref) {
        await this.#ref.waitForLoadState(opts.waitUntil, opts);
        response = await this.#ref.waitForResponse(
          (res) => res.status() >= 200 && res.status() < 400,
          opts
        );
      }
    } catch (err: any) {
      this.throwIfNotTimeout(err);
    } finally {
      // We remove listener, because we don't want more response
      this.#ref!.removeListener('response', onResponse);
    }

    return response;
  }

  /**
   * Get performance metrics from the page.
   * This function can fail silently because it's non-critical resource.
   * If that happen it will return previous metrics.
   */
  async saveMetrics(): Promise<PageMetrics> {
    try {
      if (!this.#ref || this.#ref.isClosed()) {
        // page has been closed or not yet open
        return this.#metrics;
      }

      const evaluate = await promiseWithTimeout(
        this.#ref!.evaluate(() => {
          return JSON.stringify({
            curr: performance.getEntriesByType('navigation')[0],
            all: performance.getEntries(),
            // @ts-expect-error only exists in chromium
            mem: performance.memory || {},
          });
        }),
        200
      );

      if (!evaluate) {
        throw new Error('Getting perf error');
      }
      const perf: Perf = JSON.parse(evaluate);

      this.#metrics.timings.download = Math.round(perf.curr.duration || 0);
      this.#metrics.mem = {
        jsHeapUsedSize: perf.mem.usedJSHeapSize || 0,
        jsHeapTotalSize: perf.mem.totalJSHeapSize || 0,
      };
    } catch (err: any) {
      if (!METRICS_IGNORED_ERRORS.some((msg) => err.message.includes(msg))) {
        report(new Error('Error saving metrics'), { err });
      }
    }

    return this.#metrics;
  }

  /**
   * Output body as a string at the moment it is requested.
   */
  async renderBody(
    { silent }: { silent: boolean } = { silent: false }
  ): Promise<string | null> {
    try {
      return await promiseWithTimeout(
        (async (): Promise<string | null> => {
          const start = Date.now();
          const content = await this.#ref?.evaluate(() => {
            const doctype = document.doctype
              ? new XMLSerializer().serializeToString(document.doctype)
              : '';
            // https://html.spec.whatwg.org/#dom-parsing-and-serialization
            if (!('getHTML' in Element.prototype)) {
              return `${doctype}${document.documentElement.outerHTML}`;
            }
            const body = (document.body as any).getHTML({ serializableShadowRoots: true });
            const uid = crypto.randomUUID();
            document.body.innerHTML = uid;
            return `${doctype}${document.documentElement.outerHTML.replace(
              uid,
              body
            )}`;
          });

          stats.timing('renderscript.renderBody', Date.now() - start, {
            browser: this.#engine as string,
          });
          return content || null;
        })(),
        10000 // this is the most important part so we try hard
      );
    } catch (err: any) {
      if (!(err instanceof PromiseWithTimeoutError)) {
        if (!silent) {
          throw err;
        }
      }
      report(err, {
        url: this.ref?.url(),
        browser: this.#engine,
        action: 'renderBody',
      });
    }
    return null;
  }

  /**
   * Add cookies to the context.
   */
  async setCookies({ url, headersToForward }: TaskBaseParams): Promise<void> {
    const cookies = headersToForward!.cookie.split('; ').map((cookie) => {
      const [key, ...v] = cookie.split('=');
      return { domain: url.hostname, path: '/', name: key, value: v.join('=') };
    });

    try {
      await this.#context!.addCookies(cookies);
    } catch (err) {
      report(new Error('Failed to set cookie'), { err, url });
    }
  }

  /**
   * Disable service workers, this is recommended.
   */
  async setDisableServiceWorker(): Promise<void> {
    await this.#context!.addInitScript(() => {
      // @ts-expect-error read-only prop
      delete window.navigator.serviceWorker;
    });
    this.#ref!.on('worker', () => {
      report(new Error('WebWorker disabled but created'), {
        pageUrl: this.#ref!.url(),
      });
    });
  }

  /**
   * Disable navigation. Only opt-in because Login requires navigation.
   * Because playwright has some limitation we can't cancel redirection directly, so it's not bulletproof.
   * Request will most likely be interrupted but due do code lag and event we can still have time to reach the backend.
   */
  setDisableNavigation(
    originalUrl: string,
    onNavigation: (url: string) => Promise<void>
  ): void {
    this.#ref?.on('framenavigated', async (frame) => {
      const newUrl = new URL(frame.url());
      newUrl.hash = '';
      if (originalUrl === newUrl.href) {
        return;
      }
      if (frame.parentFrame()) {
        // Sub Frame we don't care
        return;
      }
      if (newUrl.href === 'chrome-error://chromewebdata/') {
        // Page crashed
        return;
      }
      if (!this.#redirection) {
        // Can happen that on('framenavigated') event comes before on('request')
        this.#redirection = newUrl.href;
      }

      await onNavigation(newUrl.href);

      // We still report just in case.
      log.warn(
        {
          pageUrl: originalUrl,
          to: newUrl.href,
        },
        'Unexpected navigation'
      );
    });

    this.#ref?.on('request', async (req) => {
      const newUrl = new URL(req.url());

      // Playwright does not route redirection to route() so we need to manually catch them
      const main = req.frame().parentFrame() === null;
      const redir = req.isNavigationRequest();

      if (!redir || (redir && !main) || originalUrl === newUrl.href) {
        return;
      }

      newUrl.hash = '';
      if (originalUrl === newUrl.href) {
        return;
      }

      log.info('Will navigate', { pageUrl: originalUrl, url: newUrl.href });

      this.#redirection = newUrl.href;
      await onNavigation(newUrl.href);
    });
  }

  /**
   * Helper to throw if an error is not timeout so we can reuse the response easily.
   */
  throwIfNotTimeout(err: any): Error {
    if (!(err instanceof Error) || err.name !== 'TimeoutError') {
      throw err;
    }

    // This error is expected has most page will reach timeout
    // we want to continue because we can still have a response
    this.#hasTimeout = true;
    return err;
  }

  /**
   * Get a generic request handler (route).
   * That will disallow most content a.
   */
  getOnRequestHandler({
    url,
    adblock,
    headersToForward,
  }: TaskBaseParams): (route: Route) => Promise<void> {
    return async (route: Route): Promise<void> => {
      const req = route.request();
      const reqUrl = req.url();
      this.#metrics.requests.total += 1;

      try {
        if (this.#hasTimeout) {
          // If the page was killed in the meantime we don't want to process anything else
          await route.abort('blockedbyclient');
          return;
        }

        // Skip data URIs
        if (DATA_REGEXP.test(reqUrl)) {
          this.#metrics.requests.blocked += 1;
          await route.abort('blockedbyclient');
          return;
        }

        // Iframe block
        if (req.frame().parentFrame()) {
          this.#metrics.requests.blocked += 1;

          await route.abort('blockedbyclient');
          return;
        }

        // Ignore some type of resources
        if (IGNORED_RESOURCES.includes(req.resourceType())) {
          this.#metrics.requests.blocked += 1;

          await route.abort('blockedbyclient');
          return;
        }

        // Adblocking
        if (adblock && adblocker.match(new URL(reqUrl))) {
          this.#metrics.requests.blocked += 1;

          await route.abort('blockedbyclient');
          return;
        }

        // Check for ssrf attempts = page that redirects to localhost for example
        if (!(await isURLAllowed(reqUrl))) {
          this.#metrics.requests.blocked += 1;
          await route.abort('blockedbyclient');
          return;
        }

        if (req.isNavigationRequest()) {
          const headers = await req.allHeaders();
          await route.continue({
            // headers ignore values set for `Cookie`, relies to page.setCookie instead
            headers: { ...headers, ...headersToForward },
          });
          return;
        }

        await route.continue();
      } catch (err: any) {
        if (REQUEST_IGNORED_ERRORS.some((msg) => err.message.includes(msg))) {
          return;
        }

        report(err, {
          context: 'onRequest',
          url: url.href,
          with: reqUrl,
          browser: this.#engine,
        });
      }
    };
  }

  getOnResponseHandler({
    url,
  }: TaskBaseParams): (res: Response) => Promise<void> {
    return async (res: Response) => {
      if (this.#hasTimeout) {
        // If the page was killed in the meantime we don't want to process anything else
        return;
      }

      if (this.isClosed) {
        return;
      }

      const reqUrl = res.url();
      const headers = await res.allHeaders();
      let length = 0;

      // Store initial response in case of navigation
      if (!this.#initialResponse) {
        this.#initialResponse = res;
      }

      if (headers['content-length']) {
        length = parseInt(headers['content-length'], 10);
      }

      const status = res.status();

      // Redirections do not have a body
      if (status > 300 && status < 400) {
        return;
      }

      try {
        if (length === 0 && !this.isClosed) {
          // Not every request has the content-length header, the byteLength match perfectly
          // but does not necessarly represent what was transfered (if it was gzipped for example)
          length = (await res.body()).byteLength;
        }

        if (reqUrl === url.href) {
          // If this is our original URL we log it to a dedicated metric
          this.#metrics.contentLength.main = length;
        }

        this.#metrics.contentLength.total += length;
      } catch (err: any) {
        if (RESPONSE_IGNORED_ERRORS.some((msg) => err.message.includes(msg))) {
          return;
        }

        // We can not throw in callback, it will go directly into unhandled
        report(err, { context: 'onResponse', pageUrl: url.href, reqUrl });
      }
    };
  }

  /**
   * Returns the URL if found.
   */
  async checkForHttpEquivRefresh({
    timeout,
  }: {
    timeout: number;
  }): Promise<URL | void> {
    if (!this.#ref) {
      return;
    }

    try {
      const url = new URL(this.#ref.url());
      const metaRefreshElement = this.#ref.locator(
        'meta[http-equiv="refresh"]'
      );

      if (!metaRefreshElement || (await metaRefreshElement.count()) <= 0) {
        return;
      }

      const el = (await metaRefreshElement.elementHandle({ timeout }))!;
      const metaRefreshContent = await el.getProperty('content');
      const refreshContent = await metaRefreshContent?.jsonValue();
      const match = refreshContent?.match(/\d+;\s(?:url|URL)=(.*)/);
      if (!match) {
        return;
      }

      // Sometimes URLs are surrounded by quotes
      const matchedURL = match[1].replace(/'/g, '');
      const redirectURL = new URL(matchedURL, url);

      log.debug('Meta refresh found', { redir: redirectURL.href });

      return redirectURL;
    } catch (err: any) {
      if (err instanceof Error && cleanErrorMessage(err) !== 'unknown_error') {
        return;
      }
      report(new Error('Error while trying to check for meta refresh'), {
        err,
        timeout: this.#hasTimeout,
      });
    }
  }
}
