import { createExpressApp } from './server.js';

/**
 * Runnable Express CAPTCHA example entry point.
 *
 * Configuration is read from the environment:
 *
 *   PORT                 HTTP port (default 3000)
 *   HOST                 Bind address (default 127.0.0.1)
 *   CAPTCHA_DIFFICULTY   Leading-zero-bit difficulty (default 16)
 *   CAPTCHA_TTL_MS       Challenge lifetime in milliseconds (default 300000)
 *
 * Start with:
 *
 *   npm run example:express
 *
 * or directly:
 *
 *   node examples/express/index.js
 */

function readIntegerEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, received ${JSON.stringify(raw)}`);
  }
  return value;
}

const port = readIntegerEnvironment('PORT', 3000);
const host = process.env.HOST ?? '127.0.0.1';

const app = createExpressApp({
  difficulty: readIntegerEnvironment('CAPTCHA_DIFFICULTY', 16),
  ttl: readIntegerEnvironment('CAPTCHA_TTL_MS', 300_000)
});

const server = app.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`hashcash-captcha Express example listening at http://${host}:${actualPort}`);
});
