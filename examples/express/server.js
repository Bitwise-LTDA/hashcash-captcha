import { fileURLToPath } from 'node:url';

import express from 'express';

import { createChallengeService } from 'hashcash-captcha/server';

/**
 * Express integration example for the hashcash-captcha challenge service.
 *
 * The framework dependency lives only in this example application. The
 * `hashcash-captcha` library itself continues to use only `node:crypto` and
 * browser-compatible ES modules; it gains no Express or other web-framework
 * dependency.
 *
 * The app exposes two JSON endpoints and serves a small browser page:
 *
 *   GET  /api/captcha/challenge
 *     Issues a fresh challenge and returns
 *     `{ token, challenge, difficulty, expiresAt }` with `Cache-Control:
 *     no-store`.
 *
 *   POST /api/captcha/verify
 *     Accepts `{ token, nonce }`, atomically verifies the solution with the
 *     challenge service, and returns `{ ok: true }` or `{ ok: false }` without
 *     ever returning the stored challenge record.
 *
 *   GET  /
 *     Serves the browser page that mounts `mountCaptcha`.
 *
 * The `GET /vendor/*` routes serve the library's browser modules directly
 * from `src/`, so the page can import `mountCaptcha` and its WebGPU/JavaScript
 * dispatcher through ordinary ES-module URLs.
 */

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL('../../src/', import.meta.url));
const INDEX_PATH = fileURLToPath(new URL('./public/index.html', import.meta.url));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Create the Express CAPTCHA example app.
 *
 * @param {object} [options] Options forwarded to `createChallengeService`.
 *   `difficulty` (default 16) and `ttl` (default 300000) are the values most
 *   commonly overridden for local development.
 * @returns {import('express').Express} Configured Express application.
 */
export function createExpressApp(options = {}) {
  const service = createChallengeService(options);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb', type: 'application/json' }));

  app.get('/api/captcha/challenge', async (_request, response) => {
    try {
      const payload = await service.issueChallenge();
      response.set('Cache-Control', 'no-store');
      response.status(200).json(payload);
    } catch {
      // Do not leak service or store internals to API clients.
      response.status(500).json({
        ok: false,
        error: 'failed to issue challenge'
      });
    }
  });

  app.post('/api/captcha/verify', async (request, response) => {
    const body = request.body;

    if (!isObject(body)) {
      response.status(400).json({
        ok: false,
        error: 'expected a JSON object with token and nonce'
      });
      return;
    }

    const { token, nonce } = body;
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      typeof nonce !== 'number' ||
      !Number.isSafeInteger(nonce) ||
      nonce < 0
    ) {
      response.status(400).json({
        ok: false,
        error:
          'token must be a non-empty string and nonce must be a non-negative safe integer'
      });
      return;
    }

    const ok = await service.verifySolution(token, nonce);
    response.status(200).json({ ok });
  });

  // Serve the browser modules first, then the static page assets. The page
  // imports `/vendor/widget.js`, whose relative imports resolve to the other
  // files in `src/`.
  app.use('/vendor', express.static(VENDOR_DIR, { fallthrough: true }));
  app.get('/', (_request, response) => {
    response.sendFile(INDEX_PATH);
  });
  app.use(express.static(PUBLIC_DIR));

  // Final error boundary. Express JSON parse errors arrive here; other errors
  // are returned as generic JSON without internal detail.
  // eslint-disable-next-line no-unused-vars
  app.use((error, _request, response, _next) => {
    if (
      error &&
      (error.type === 'entity.parse.failed' ||
        (error instanceof SyntaxError && 'body' in error))
    ) {
      response.status(400).json({
        ok: false,
        error: 'invalid JSON body'
      });
      return;
    }

    response.status(500).json({
      ok: false,
      error: 'internal server error'
    });
  });

  return app;
}
