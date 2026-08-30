# Express integration example

This example connects the existing challenge service, browser widget, and
automatic WebGPU/JavaScript solver through two HTTP endpoints:

- `GET /api/captcha/challenge` issues a challenge and returns the
  widget-compatible `{ token, challenge, difficulty, expiresAt }` payload with
  JSON and `Cache-Control: no-store` headers.
- `POST /api/captcha/verify` accepts `{ token, nonce }`, calls the challenge
  service's `verifySolution`, and returns `{ ok: true }` for the first valid
  solution or `{ ok: false }` for an unknown, expired, replayed, or incorrect
  submission. Stored challenge records are never returned by this endpoint.

The server also serves a browser page at `/` that mounts `mountCaptcha`,
fetches challenges from the GET endpoint, submits `{ token, nonce }` after
solving, and visibly reports server-confirmed success or rejection.

## Installation and startup

From the repository root:

```sh
npm install
npm run example:express
```

Then open <http://127.0.0.1:3000>. You can also start the example directly:

```sh
node examples/express/index.js
```

## Configuration

The example reads these environment variables:

| Variable             | Default | Meaning                                   |
| -------------------- | ------- | ----------------------------------------- |
| `PORT`               | `3000`  | HTTP port to listen on.                   |
| `HOST`               | `127.0.0.1` | Bind address.                        |
| `CAPTCHA_DIFFICULTY` | `16`    | Leading-zero-bit difficulty, `0`–`256`.  |
| `CAPTCHA_TTL_MS`     | `300000`| Challenge lifetime in milliseconds.       |

For local experimentation, a low difficulty issues fast challenges:

```sh
CAPTCHA_DIFFICULTY=8 CAPTCHA_TTL_MS=60000 npm run example:express
```

The same options can be passed programmatically to `createExpressApp`:

```js
import { createExpressApp } from './server.js';

const app = createExpressApp({
  difficulty: 8,
  ttl: 60_000
});
```

## Production store

This example uses the challenge service's default `MemoryTokenStore`. That
store is **process-local**: challenges are kept in a private `Map` inside this
Node.js process, so they do not survive a restart and are not shared across
multiple server instances or load-balanced processes.

For production, use the existing Redis-backed token store from
`hashcash-captcha/redis` instead. Inject it through `createExpressApp`, which
forwards `store` to `createChallengeService`:

```js
import { createClient } from 'redis';
import { RedisTokenStore } from 'hashcash-captcha/redis';
import { createExpressApp } from './server.js';

const redisClient = createClient();
await redisClient.connect();

const app = createExpressApp({
  difficulty: Number(process.env.CAPTCHA_DIFFICULTY ?? 16),
  ttl: Number(process.env.CAPTCHA_TTL_MS ?? 300_000),
  store: new RedisTokenStore(redisClient, {
    prefix: 'hashcash-captcha:'
  })
});
```

`RedisTokenStore` does not add a Redis client dependency to this library; it
accepts any async Redis-compatible client implementing its minimal contract
(for example `node-redis` v4+).
