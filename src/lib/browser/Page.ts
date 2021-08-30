import { validateURL } from '@algolia/dns-filter';
import type {
  BrowserContext,
  HTTPResponse,
  Page,
} from 'puppeteer-core/lib/esm/puppeteer/api-docs-entry';

import { FetchError } from 'api/helpers/errors';
import { stats } from 'helpers/stats';
import { injectBaseHref } from 'lib/helpers/injectBaseHref';
import { adblocker } from 'lib/singletons';
import type { Task } from 'lib/tasks/Task';
import type { PageMetrics } from 'lib/types';

import {
  DATA_REGEXP,
  HEIGHT,
  IGNORED_RESOURCES,
  RESTRICTED_IPS,
  WIDTH,
} from '../constants';

import type { Browser } from './Browser';

const IGNORED_ERRORS = [
  // 200 no body, HEAD, OPTIONS
  'No data found for resource with given identifier',
  'No resource with given identifier found',
  // Too big to fit in memory, or memory filled
  'Request content was evicted from inspector cache',
];

export class BrowserPage {
  #page: Page | undefined;
  #context: BrowserContext | undefined;
  #task: Task | undefined;
  #metrics: PageMetrics = {
    layoutDuration: null,
    scriptDuration: null,
    taskDuration: null,
    jsHeapUsedSize: null,
    jsHeapTotalSize: null,
    requests: 0,
    blockedRequests: 0,
    contentLength: 0,
    contentLengthTotal: 0,
  };

  get page(): Page | undefined {
    return this.#page;
  }

  get context(): BrowserContext | undefined {
    return this.#context;
  }

  /**
   * Create an empty page in a browser.
   */
  async create(browser: Browser): Promise<void> {
    const context = await browser.instance!.createIncognitoBrowserContext();

    const start = Date.now();
    const page = await context.newPage();

    await page.setUserAgent('Algolia Crawler Renderscript');
    await page.setCacheEnabled(false);
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    // To enable later
    // await page.setExtraHTTPHeaders({
    //   'Accept-Encoding': 'gzip, deflate',
    //   Accept:
    //     'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    // });

    stats.timing('renderscript.page.create', Date.now() - start);
    this.#page = page;
    this.#context = context;
  }

  /**
   * Destroy the page and the private context.
   */
  async close(): Promise<void> {
    await this.#page?.close();
    await this.#context?.close();
  }

  async metrics(): Promise<PageMetrics> {
    const metrics = await this.#page!.metrics();
    return {
      ...this.#metrics,
      layoutDuration: Math.round((metrics.LayoutDuration || 0) * 1000),
      scriptDuration: Math.round((metrics.ScriptDuration || 0) * 1000),
      taskDuration: Math.round((metrics.TaskDuration || 0) * 1000),
      jsHeapUsedSize: metrics.JSHeapUsedSize || 0,
      jsHeapTotalSize: metrics.JSHeapTotalSize || 0,
    };
  }

  async linkToTask(task: Task): Promise<void> {
    this.#task = task;
    await this.#updateContext();
  }

  async goto(url: URL): Promise<HTTPResponse> {
    let response: HTTPResponse | null = null;
    const timeout = this.#task!.params.waitTime!.max;

    this.#page!.on('response', (r) => {
      if (!response) {
        response = r;
      }
    });

    const start = Date.now();
    try {
      response = await this.#page!.goto(url.href, {
        timeout,
        waitUntil: ['domcontentloaded', 'networkidle0'],
      });
    } catch (e: any) {
      if (e.message.match(/Navigation Timeout Exceeded/)) {
        throw new FetchError('no_response', true);
      } else {
        console.error('Caught error when loading page', e);
      }
    } finally {
      stats.timing('renderscript.page.goto', Date.now() - start, undefined, {
        success: response ? 'true' : 'false',
      });
    }

    /* Fetch errors */
    if (!response) {
      throw new FetchError('no_response');
    }
    return response;
  }

  async renderBody(url: URL): Promise<string> {
    const baseHref = `${url.protocol}//${url.host}`;

    await this.#page!.evaluate(injectBaseHref, baseHref);
    return (await this.#page!.evaluate(
      'document.firstElementChild.outerHTML'
    )) as string;
  }

  async #updateContext(): Promise<void> {
    const { url, headersToForward, userAgent, adblock } = this.#task!.params!;

    await this.#page!.setUserAgent(userAgent);

    await this.#page!.setRequestInterception(true);
    if (headersToForward.cookie) {
      const cookies = headersToForward.cookie.split('; ').map((cookie) => {
        const [key, ...v] = cookie.split('=');
        // url attribute is required because it is not possible set cookies on a blank page
        // so page.setCookie would crash if no url is provided, since we start with a blank page
        return { url: url.href, name: key, value: v.join('=') };
      });
      try {
        await this.#page!.setCookie(...cookies);
      } catch (e) {
        console.error('failed to set cookie on page', url);
      }
    }

    /* Ignore useless/dangerous resources */
    this.#page!.on('request', async (req) => {
      const reqUrl = req.url();
      this.#metrics.requests += 1;

      // Skip data URIs
      if (DATA_REGEXP.test(reqUrl)) {
        this.#metrics.blockedRequests += 1;
        req.abort();
        return;
      }

      // check for ssrf attempts
      try {
        await validateURL({
          url: reqUrl,
          ipPrefixes: RESTRICTED_IPS,
        });
      } catch (err: any) {
        if (!err.message.includes('ENOTFOUND')) {
          console.error(err);
          this.#metrics.blockedRequests += 1;
        }
        req.abort();
        return;
      }

      try {
        // Ignore some type of resources
        if (IGNORED_RESOURCES.includes(req.resourceType())) {
          this.#metrics.blockedRequests += 1;
          await req.abort();
          return;
        }
        if (adblock && adblocker.match(new URL(reqUrl))) {
          this.#metrics.blockedRequests += 1;
          await req.abort();
          return;
        }

        if (req.isNavigationRequest()) {
          const headers = req.headers();
          await req.continue({
            // headers ignore values set for `Cookie`, relies to page.setCookie instead
            headers: { ...headers, ...headersToForward },
          });
          return;
        }
        await req.continue();
      } catch (e: any) {
        if (!e.message.match(/Request is already handled/)) {
          throw e;
        }
        // Ignore Request is already handled error
      }
    });

    this.#page!.on('response', async (res) => {
      const headers = res.headers();

      let cl = 0;

      if (headers['content-length']) {
        cl = parseInt(headers['content-length'], 10);
      }

      const status = res.status();
      // Redirection does not have a body
      if (status < 300 || status >= 400) {
        try {
          // Not every request has the content-length header, the byteLength match perfectly
          // but does not necessarly represent what was transfered (if it was gzipped for example)
          cl = (await res.buffer()).byteLength;
        } catch (e: any) {
          if (IGNORED_ERRORS.some((msg) => e.message.includes(msg))) {
            return;
          }

          throw e;
        }
      }

      if (res.url() === url.href) {
        this.#metrics.contentLength = cl;
      }

      this.#metrics.contentLengthTotal += cl;
    });
  }
}
