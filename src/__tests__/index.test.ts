import { cleanString, request } from './helpers';

jest.setTimeout(30 * 1000);

describe('main', () => {
  it('should error when no url', async () => {
    const { res, body } = await request('http://localhost:3000/render?');

    expect(res.statusCode).toBe(400);

    expect(JSON.parse(body)).toEqual({
      details: [
        { label: 'url', message: 'url is required', type: 'required' },
        { label: 'ua', message: 'ua is required', type: 'required' },
      ],
      error: true,
      message: 'Bad Request',
    });
  });

  it('should error when no user agent', async () => {
    const { res, body } = await request(
      'http://localhost:3000/render?url=http%3A%2F%2Flocalhost%3A3000%2Ftest-website%2Fbasic.html'
    );

    expect(res.statusCode).toBe(400);

    expect(JSON.parse(body)).toEqual({
      error: true,
      message: 'Bad Request',
      details: [{ label: 'ua', type: 'required', message: 'ua is required' }],
    });
  });

  it('should validate waitTime', async () => {
    const { res, body } = await request(
      'http://localhost:3000/render?url=http%3A%2F%2Flocalhost%3A3000%2Ftest-website%2Fbasic.html&ua=Algolia+Crawler&waitTime[min]=foo&waitTime[max]=bar'
    );

    expect(res.statusCode).toBe(400);

    expect(JSON.parse(body)).toEqual({
      error: true,
      message: 'Bad Request',
      details: [
        {
          errors: [
            {
              label: 'min',
              message: 'min must be a valid number',
              type: 'number.typeof',
            },
            {
              label: 'max',
              message: 'max must be a valid number',
              type: 'number.typeof',
            },
          ],
          label: 'waitTime',
          message: 'waitTime does not match its schema',
          type: 'object.schema',
        },
      ],
    });
  });

  it.each(['chromium', 'firefox'])(
    'should render basic page on %s',
    async (browser) => {
      const { res, body } = await request(
        `http://localhost:3000/render?url=http%3A%2F%2Flocalhost%3A3000%2Ftest-website%2Fbasic.html&ua=Algolia+Crawler&browser=${browser}`
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers).toEqual({
        connection: 'keep-alive',
        'content-length': '79',
        'content-security-policy':
          "default-src 'none'; style-src * 'unsafe-inline'; img-src * data:; font-src *",
        'content-type': 'text/html; charset=utf-8',
        date: expect.any(String),
        etag: 'W/"4f-3aYUmdp4dkv6HiR9rJEG+VKiCsw"',
        'keep-alive': 'timeout=5',
      });

      expect(cleanString(body)).toBe(
        `<!DOCTYPE html><html><head></head><body>A basic page</body></html>`
      );
    }
  );
});
