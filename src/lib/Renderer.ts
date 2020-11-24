import * as puppeteer from 'puppeteer-core';
import { v4 as uuid } from 'uuid';
import { validateURL, PRIVATE_IP_PREFIXES } from '@algolia/dns-filter';

const IP_PREFIXES_WHITELIST = process.env.IP_PREFIXES_WHITELIST
  ? process.env.IP_PREFIXES_WHITELIST.split(',')
  : ['127.', '0.', '::1'];

const RESTRICTED_IPS =
  process.env.ALLOW_LOCALHOST === 'true'
    ? PRIVATE_IP_PREFIXES.filter(
        (prefix: string) => !IP_PREFIXES_WHITELIST.includes(prefix)
      ) // relax filtering
    : PRIVATE_IP_PREFIXES; // no private IPs otherwise

import injectBaseHref from 'lib/helpers/injectBaseHref';
import getChromiumExecutablePath from 'lib/helpers/getChromiumExecutablePath';

const WIDTH = 1280;
const HEIGHT = 1024;
const IGNORED_RESOURCES = ['font', 'image'];
const PAGE_BUFFER_SIZE = 2;
const TIMEOUT = 10000;

export interface TaskParams {
  url: URL;
  headersToForward: {
    [s: string]: string;
  };
}

export interface TaskResult {
  statusCode?: number;
  body?: string;
  headers?: { [s: string]: string };
  timeout?: boolean;
  error?: string;
}

interface TaskObject {
  id: string;
  promise: Promise<TaskResult>;
}

class Renderer {
  id: string;
  ready: boolean;
  nbTotalTasks: number;
  private _browser: puppeteer.Browser | null;
  private _stopping: boolean;
  private _pageBuffer: Array<
    Promise<{
      page: puppeteer.Page;
      context: puppeteer.BrowserContext;
    }>
  >;
  private _currentTasks: Array<{ id: string; promise: TaskObject['promise'] }>;
  private _createBrowserPromise: Promise<void> | null;

  constructor() {
    this.id = uuid();
    this.ready = false;
    this.nbTotalTasks = 0;
    this._browser = null;
    this._stopping = false;
    this._createBrowserPromise = this._createBrowser();
    this._pageBuffer = Array.from(new Array(PAGE_BUFFER_SIZE), () =>
      this._createNewPage()
    );
    this._currentTasks = [];

    Promise.all(this._pageBuffer).then(() => {
      this.ready = true;
      console.info(`Browser ${this.id} ready`);
    });
  }

  async task(job: TaskParams) {
    if (this._stopping) {
      throw new Error('Called task on a stopping Renderer');
    }
    ++this.nbTotalTasks;

    const id = uuid();
    const promise = this._processPage(job);
    this._addTask({ id, promise });

    const res = await promise;

    this._removeTask({ id });

    return res;
  }

  async stop() {
    this._stopping = true;
    console.info(`Browser ${this.id} stopping...`);
    while (!this.ready) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await Promise.all(this._currentTasks.map(({ promise }) => promise));
    await Promise.all(this._pageBuffer);
    const browser = await this._getBrowser();
    await browser.close();
    console.info(`Browser ${this.id} stopped`);
  }

  async healthy() {
    if (this._stopping) return false;
    try {
      const browser = await this._getBrowser();
      await browser.version();
      return true;
    } catch (e) {
      return false;
    }
  }

  private async _createBrowser() {
    console.info(`Browser ${this.id} creating...`);

    // Call this before launching the browser,
    // otherwise the launch call might timeout
    // await adBlocker.waitForReadyness();

    const env: { [s: string]: string } = {};
    if (process.env.DISPLAY) {
      env.DISPLAY = process.env.DISPLAY;
    }

    const browser = await puppeteer.launch({
      headless: true,
      env,
      executablePath: await getChromiumExecutablePath(),
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
      handleSIGINT: false,
      handleSIGTERM: false,
      pipe: true,
      args: [
        // Disable sandboxing when not available
        '--no-sandbox',
        // No GPU available inside Docker
        '--disable-gpu',
        // Seems like a powerful hack, not sure why
        // https://github.com/Codeception/CodeceptJS/issues/561
        "--proxy-server='direct://'",
        '--proxy-bypass-list=*',
        // Disable cache
        '--disk-cache-dir=/dev/null',
        '--media-cache-size=1',
        '--disk-cache-size=1',
        // Disable useless UI features
        '--no-first-run',
        '--noerrdialogs',
        '--disable-notifications',
        '--disable-translate',
        '--disable-infobars',
        '--disable-features=TranslateUI',
        // Disable dev-shm
        // See https://github.com/GoogleChrome/puppeteer/blob/master/docs/troubleshooting.md#tips
        '--disable-dev-shm-usage',
      ].filter((e) => e !== ''),
    });

    // Try to load a test page first
    const testPage = await browser.newPage();
    await testPage.goto('about://settings', { waitUntil: 'networkidle0' });

    this._browser = browser;
    this._createBrowserPromise = null;
  }

  // Not a `get`ter because the method is `async`
  private async _getBrowser() {
    if (this._createBrowserPromise) {
      await this._createBrowserPromise;
    }

    // We know that _browser is created at the end of the promise
    return this._browser as puppeteer.Browser;
  }

  private async _defineRequestContextForPage({
    page,
    task,
  }: {
    page: puppeteer.Page;
    task: TaskParams;
  }) {
    const { url, headersToForward } = task;

    await page.setRequestInterception(true);
    if (headersToForward.cookie) {
      const cookies = headersToForward.cookie.split('; ').map((c) => {
        const [key, ...v] = c.split('=');
        // url attribute is required because it is not possible set cookies on a blank page
        // so page.setCookie would crash if no url is provided, since we start with a blank page
        return { url: url.href, name: key, value: v.join('=') };
      });
      try {
        await page.setCookie(...cookies);
      } catch (e) {
        console.error('failed to set cookie on page', url);
      }
    }

    /* Ignore useless/dangerous resources */
    page.on('request', async (req: puppeteer.Request) => {
      // check for ssrf attempts
      try {
        await validateURL({
          url: req.url(),
          ipPrefixes: RESTRICTED_IPS,
        });
      } catch (err) {
        // log.error(err);
        // report(err);
        req.abort();
      }

      try {
        // Ignore some type of resources
        if (IGNORED_RESOURCES.includes(req.resourceType())) {
          await req.abort();
          return;
        }
        // Use AdBlocker to ignore more resources
        // if (
        //   await adBlocker.test(
        //     req.url(),
        //     req.resourceType(),
        //     new URL(page.url()).host
        //   )
        // ) {
        //   await req.abort();
        //   return;
        // }
        // console.log(req.resourceType(), req.url());
        if (req.isNavigationRequest()) {
          const headers = req.headers();
          await req.continue({
            // headers ignore values set for `Cookie`, relies to page.setCookie instead
            headers: { ...headers, ...headersToForward },
          });
          return;
        }
        await req.continue();
      } catch (e) {
        if (!e.message.match(/Request is already handled/)) throw e;
        // Ignore Request is already handled error
      }
    });
  }

  private async _createNewPage() {
    if (this._stopping) {
      throw new Error('Called _createNewPage on a stopping Renderer');
    }

    const browser = await this._getBrowser();
    const context = await browser.createIncognitoBrowserContext();
    const page = await context.newPage();

    await page.setUserAgent('Algolia Crawler Renderscript');
    await page.setCacheEnabled(false);
    await page.setViewport({ width: WIDTH, height: HEIGHT });

    return { page, context };
  }

  private async _newPage() {
    this._pageBuffer.push(this._createNewPage());
    return await this._pageBuffer.shift()!;
  }

  private async _processPage(
    task: TaskParams
  ): Promise<{
    error?: string;
    statusCode?: number;
    headers?: any;
    body?: string;
    timeout?: boolean;
    resolvedUrl?: string;
  }> {
    /* Setup */
    const { url } = task;
    const { context, page } = await this._newPage();

    await this._defineRequestContextForPage({ page, task });

    let response: puppeteer.Response | null = null;
    let timeout = false;
    page.addListener('response', (r: puppeteer.Response) => {
      if (!response) response = r;
    });
    try {
      response = await page.goto(url.href, {
        timeout: TIMEOUT,
        waitUntil: 'networkidle0',
      });
    } catch (e) {
      if (e.message.match(/Navigation Timeout Exceeded/)) {
        timeout = true;
      } else {
        console.error('Caught error when loading page', e);
      }
    }

    /* Fetch errors */
    if (!response) return { error: 'no_response' };

    /* Transforming */
    const statusCode = response.status();
    const baseHref = `${url.protocol}//${url.host}`;
    await page.evaluate(injectBaseHref, baseHref);

    /* Serialize */
    await page.evaluate(() => {
      // eslint-disable-next-line no-debugger
      debugger;
    });
    const preSerializationUrl = await page.evaluate('window.location.href');
    const body = (await page.evaluate(
      'document.firstElementChild.outerHTML'
    )) as string;
    const headers = response.headers();
    const resolvedUrl = (await page.evaluate('window.location.href')) as string;
    /* Cleanup */
    await context.close();

    if (preSerializationUrl !== resolvedUrl) {
      // something super shady happened where the page url changed during evaluation
      return { error: 'unsafe_redirect' };
    }

    return { statusCode, headers, body, timeout, resolvedUrl };
  }

  private _addTask({ id, promise }: TaskObject) {
    this._currentTasks.push({ id, promise });
  }

  private _removeTask({ id }: Pick<TaskObject, 'id'>) {
    const idx = this._currentTasks.findIndex(({ id: _id }) => id === _id);
    // Should never happen
    if (idx === -1) throw new Error('Could not find task');
    this._currentTasks.splice(idx, 1);
  }
}

export default Renderer;
