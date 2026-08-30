import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { solve } from '../src/pow.js';
import { createExpressApp } from '../examples/express/server.js';

function requestJson(baseUrl, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', body } = options;
    const hasBody = body !== undefined;
    const rawBody = hasBody ? JSON.stringify(body) : null;

    const target = new URL(pathname, baseUrl);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        agent: false,
        headers: {
          accept: 'application/json',
          ...(hasBody
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(rawBody)
              }
            : {})
        }
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          let json = null;
          try {
            json = raw.length === 0 ? null : JSON.parse(raw);
          } catch {
            // The raw body is preserved for non-JSON edge-case assertions.
          }
          resolve({
            status: response.statusCode,
            headers: response.headers,
            raw,
            json
          });
        });
      }
    );

    request.on('error', reject);
    if (hasBody) {
      request.write(rawBody);
    }
    request.end();
  });
}

function startServer(t, app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');

    server.once('listening', () => {
      const address = server.address();
      t.after(
        () =>
          new Promise((closeResolve) => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(() => closeResolve());
          })
      );
      resolve(`http://127.0.0.1:${address.port}`);
    });

    server.once('error', reject);
  });
}

function createTestApp() {
  // Difficulty 4 is intentionally low so the Node PoW core finds a nonce
  // quickly in the integration test.
  return createExpressApp({ difficulty: 4, ttl: 60_000 });
}

test('GET /api/captcha/challenge issues a widget-compatible no-store JSON payload', async (t) => {
  const baseUrl = await startServer(t, createTestApp());

  const response = await requestJson(baseUrl, '/api/captcha/challenge');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'] ?? '', /^application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');

  assert.match(response.json.token, /^[0-9a-f]{64}$/);
  assert.match(response.json.challenge, /^[0-9a-f]{64}$/);
  assert.equal(response.json.difficulty, 4);
  assert.equal(typeof response.json.expiresAt, 'number');
  assert.equal(Number.isFinite(response.json.expiresAt), true);
});

test('POST /api/captcha/verify accepts a solved challenge, rejects replay, and never returns stored records', async (t) => {
  const baseUrl = await startServer(t, createTestApp());

  const challengeResponse = await requestJson(baseUrl, '/api/captcha/challenge');
  const { token, challenge, difficulty } = challengeResponse.json;
  const nonce = solve(challenge, difficulty);

  const success = await requestJson(baseUrl, '/api/captcha/verify', {
    method: 'POST',
    body: { token, nonce }
  });
  assert.equal(success.status, 200);
  assert.deepEqual(success.json, { ok: true });
  assert.equal(Object.hasOwn(success.json, 'challenge'), false);
  assert.equal(Object.hasOwn(success.json, 'expiresAt'), false);
  assert.equal(Object.hasOwn(success.json, 'difficulty'), false);

  const replay = await requestJson(baseUrl, '/api/captcha/verify', {
    method: 'POST',
    body: { token, nonce }
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, { ok: false });
  assert.equal(Object.hasOwn(replay.json, 'challenge'), false);

  const unknown = await requestJson(baseUrl, '/api/captcha/verify', {
    method: 'POST',
    body: { token: 'unknown-token', nonce }
  });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.json, { ok: false });
});

test('POST /api/captcha/verify rejects malformed submissions with clear 400 JSON errors', async (t) => {
  const baseUrl = await startServer(t, createTestApp());

  const malformedBodies = [
    {},
    { token: 'token' },
    { nonce: 0 },
    { token: '', nonce: 0 },
    { token: 'token', nonce: -1 },
    { token: 'token', nonce: 1.5 },
    { token: 'token', nonce: '0' },
    { token: 42, nonce: 0 },
    { token: 'token', nonce: null },
    []
  ];

  for (const body of malformedBodies) {
    const response = await requestJson(baseUrl, '/api/captcha/verify', {
      method: 'POST',
      body
    });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(response.json.ok, false);
    assert.equal(typeof response.json.error, 'string');
  }

  const invalidJson = await new Promise((resolve, reject) => {
    const target = new URL('/api/captcha/verify', baseUrl);
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        agent: false,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength('{not-json')
        }
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            json: raw.length === 0 ? null : JSON.parse(raw)
          });
        });
      }
    );
    request.on('error', reject);
    request.write('{not-json');
    request.end();
  });

  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.ok, false);
  assert.match(invalidJson.json.error, /invalid JSON body/i);
});

test('the example serves the browser page and the widget module', async (t) => {
  const baseUrl = await startServer(t, createTestApp());

  const page = await requestJson(baseUrl, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);
  assert.match(page.raw, /mountCaptcha/);
  assert.match(page.raw, /\/api\/captcha\/challenge/);
  assert.match(page.raw, /\/api\/captcha\/verify/);

  const widget = await requestJson(baseUrl, '/vendor/widget.js');
  assert.equal(widget.status, 200);
  assert.match(widget.headers['content-type'] ?? '', /javascript/);
  assert.match(widget.raw, /export function mountCaptcha/);
});
