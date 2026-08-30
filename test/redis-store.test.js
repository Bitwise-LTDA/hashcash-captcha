import test from 'node:test';
import assert from 'node:assert/strict';

import { createChallengeService } from '../src/server.js';
import { RedisTokenStore } from '../src/redis-store.js';
import { solve } from '../src/pow.js';

/**
 * In-memory fake implementing the documented minimal Redis client interface
 * used by `RedisTokenStore`. `eval` emulates the store's consume and cleanup
 * Lua scripts, which is what gives concurrent consumers the same one-winner
 * behavior as Redis and makes cleanup compare-and-delete atomic.
 */
class FakeRedisClient {
  constructor({ now = () => 0 } = {}) {
    this.entries = new Map();
    this.now = now;
    this.setCalls = [];
    this.evalCalls = [];
    this.delCalls = [];
    this.cleanupCalls = [];
    this.beforeCleanupDelete = null;
  }

  #discardExpired() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  async get(key) {
    this.#discardExpired();
    const entry = this.entries.get(key);
    return entry === undefined ? null : entry.value;
  }

  async set(key, value, options = {}) {
    const px = options.PX;
    if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) {
      throw new Error(`invalid PX: ${px}`);
    }
    this.setCalls.push({ key, value: String(value), options: { PX: px } });
    this.entries.set(key, {
      value: String(value),
      expiresAt: this.now() + px
    });
    return 'OK';
  }

  async del(key) {
    this.delCalls.push({ key });
    return this.entries.delete(key) ? 1 : 0;
  }

  async #compareAndDelete(options) {
    const key = options.keys[0];
    const expected = String(options.arguments[0]);
    this.cleanupCalls.push({ key, expected });

    if (this.beforeCleanupDelete) {
      await this.beforeCleanupDelete(key, expected);
    }

    const entry = this.entries.get(key);
    const current = entry === undefined ? null : entry.value;
    if (current === expected) {
      this.entries.delete(key);
    }
    return current;
  }

  async eval(script, options) {
    this.evalCalls.push({ script, options });
    this.#discardExpired();

    if (!script.includes('cjson.decode')) {
      return this.#compareAndDelete(options);
    }

    const key = options.keys[0];
    const now = Number(options.arguments[0]);
    const entry = this.entries.get(key);

    if (entry === undefined) {
      return null;
    }

    let record;
    try {
      record = JSON.parse(entry.value);
    } catch {
      this.entries.delete(key);
      return null;
    }

    if (
      record === null ||
      typeof record !== 'object' ||
      Array.isArray(record)
    ) {
      this.entries.delete(key);
      return null;
    }

    if (
      typeof record.expiresAt !== 'number' ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= now
    ) {
      this.entries.delete(key);
      return null;
    }

    this.entries.delete(key);
    return entry.value;
  }
}

function sampleRecord(overrides = {}) {
  return {
    token: 'token',
    challenge: 'challenge',
    difficulty: 8,
    createdAt: 0,
    expiresAt: 1000,
    ...overrides
  };
}

test('RedisTokenStore validates its constructor arguments', () => {
  const client = new FakeRedisClient();

  assert.throws(() => new RedisTokenStore(), TypeError);
  assert.throws(() => new RedisTokenStore(null), TypeError);
  assert.throws(() => new RedisTokenStore({}), TypeError);
  assert.throws(
    () => new RedisTokenStore({ get: async () => null }),
    TypeError
  );
  assert.throws(
    () => new RedisTokenStore(client, { prefix: 42 }),
    TypeError
  );
  assert.throws(
    () => new RedisTokenStore(client, { now: 'tomorrow' }),
    TypeError
  );

  assert.equal(new RedisTokenStore(client) instanceof RedisTokenStore, true);
});

test('set stores a record copy and get returns a record copy', async () => {
  const client = new FakeRedisClient();
  const store = new RedisTokenStore(client, {
    prefix: 'svc:',
    now: () => 0
  });
  const record = sampleRecord();

  await store.set('token', record, 0);
  record.challenge = 'mutated-after-write';

  const first = await store.get('token', 0);
  assert.deepEqual(first, sampleRecord());
  assert.notEqual(first, null);
  assert.equal(first.challenge, 'challenge');

  first.challenge = 'mutated-after-read';

  const second = await store.get('token', 0);
  assert.equal(second.challenge, 'challenge');

  assert.equal(await store.get('missing', 0), null);
});

test('set derives the Redis TTL from record.expiresAt minus nowMs', async () => {
  const client = new FakeRedisClient({ now: () => 0 });
  const store = new RedisTokenStore(client, { now: () => 250 });

  await store.set('token', sampleRecord({ expiresAt: 1250 }), 250);

  assert.equal(client.setCalls.length, 1);
  assert.equal(client.setCalls[0].key, 'token');
  assert.equal(client.setCalls[0].options.PX, 1000);
});

test('get returns null once the Redis TTL has expired', async () => {
  let fakeNow = 0;
  const client = new FakeRedisClient({ now: () => fakeNow });
  const store = new RedisTokenStore(client, {
    prefix: 'ttl:',
    now: () => 0
  });
  const record = sampleRecord({ expiresAt: 1000 });

  await store.set('token', record, 0);
  assert.notEqual(await store.get('token', 0), null);

  // Advance only the Redis fake's clock so expiration is driven by the
  // Redis TTL rather than by the store's injected `nowMs` comparison.
  fakeNow = 1001;
  assert.equal(await store.get('token', 0), null);
});

test('get also treats a stored record whose expiresAt has passed as expired', async () => {
  const client = new FakeRedisClient({ now: () => 0 });
  const store = new RedisTokenStore(client, { now: () => 0 });

  await store.set('token', sampleRecord({ expiresAt: 1000 }), 0);

  assert.notEqual(await store.get('token', 999), null);
  assert.equal(await store.get('token', 1000), null);
});

test('get deletes malformed or invalid stored values after observing them', async () => {
  const client = new FakeRedisClient();
  const store = new RedisTokenStore(client, { prefix: 'bad:', now: () => 0 });

  const cases = [
    ['not-json', '{not json'],
    ['number', '42'],
    ['null', 'null'],
    ['string', '"hello"'],
    ['array', '[]'],
    ['expires', JSON.stringify({ token: 'bad:expires', expiresAt: 'soon' })]
  ];

  for (const [token, raw] of cases) {
    await client.set(`bad:${token}`, raw, { PX: 100000 });
  }

  for (const [token] of cases) {
    assert.equal(await store.get(token, 0), null);
  }

  assert.deepEqual(
    client.cleanupCalls.map(({ key }) => key),
    cases.map(([token]) => `bad:${token}`)
  );
  assert.equal(client.delCalls.length, 0);
  for (const [token] of cases) {
    assert.equal(client.entries.has(`bad:${token}`), false);
  }
});

test('get discards records with missing, empty, or invalid token/challenge/difficulty fields', async () => {
  const client = new FakeRedisClient();
  const store = new RedisTokenStore(client, { prefix: 'bad:', now: () => 0 });
  const complete = sampleRecord({ token: 'bad:complete', expiresAt: 1000 });

  const cases = [
    ['missing-token', { challenge: 'challenge', difficulty: 8 }],
    ['empty-token', { token: '', challenge: 'challenge', difficulty: 8 }],
    ['number-token', { token: 42, challenge: 'challenge', difficulty: 8 }],
    ['missing-challenge', { token: 'bad:missing-challenge', difficulty: 8 }],
    ['empty-challenge', { token: 'bad:empty-challenge', challenge: '', difficulty: 8 }],
    ['number-challenge', { token: 'bad:number-challenge', challenge: 42, difficulty: 8 }],
    ['missing-difficulty', { token: 'bad:missing-difficulty', challenge: 'challenge' }],
    ['string-difficulty', { token: 'bad:string-difficulty', challenge: 'challenge', difficulty: '8' }],
    ['float-difficulty', { token: 'bad:float-difficulty', challenge: 'challenge', difficulty: 8.5 }],
    ['negative-difficulty', { token: 'bad:negative-difficulty', challenge: 'challenge', difficulty: -1 }],
    ['high-difficulty', { token: 'bad:high-difficulty', challenge: 'challenge', difficulty: 257 }]
  ];

  for (const [token, record] of cases) {
    await client.set(
      `bad:${token}`,
      JSON.stringify({ expiresAt: 1000, ...record }),
      { PX: 100000 }
    );
  }
  await client.set('bad:complete', JSON.stringify(complete), { PX: 100000 });

  for (const [token] of cases) {
    assert.equal(await store.get(token, 0), null);
    assert.equal(client.entries.has(`bad:${token}`), false);
  }

  // A complete unexpired record sharing the same prefix remains readable.
  assert.deepEqual(await store.get('complete', 0), complete);
  assert.equal(client.entries.has('bad:complete'), true);
  assert.deepEqual(
    client.cleanupCalls.map(({ key }) => key),
    cases.map(([token]) => `bad:${token}`)
  );
});

test('get deletes a logically expired record after observing it', async () => {
  const client = new FakeRedisClient({ now: () => 0 });
  const store = new RedisTokenStore(client, { prefix: 'svc:', now: () => 0 });

  await store.set('token', sampleRecord({ expiresAt: 1000 }), 0);

  assert.notEqual(await store.get('token', 999), null);
  assert.equal(client.cleanupCalls.length, 0);

  assert.equal(await store.get('token', 1000), null);
  assert.deepEqual(client.cleanupCalls.map(({ key }) => key), ['svc:token']);
  assert.equal(client.entries.has('svc:token'), false);
});

test('get leaves a replacement value intact when cleanup races with a write', async () => {
  const client = new FakeRedisClient({ now: () => 0 });
  const store = new RedisTokenStore(client, { prefix: 'svc:', now: () => 0 });
  const replacement = sampleRecord({ challenge: 'replacement' });

  await client.set('svc:token', '{not json', { PX: 100000 });

  // Simulate another writer replacing the malformed value after get() reads it
  // but before the cleanup delete runs.
  client.beforeCleanupDelete = async (key) => {
    await client.set(key, JSON.stringify(replacement), { PX: 100000 });
  };

  assert.equal(await store.get('token', 0), null);

  assert.equal(client.cleanupCalls.length, 1);
  assert.equal(client.entries.has('svc:token'), true);
  assert.equal(
    client.entries.get('svc:token').value,
    JSON.stringify(replacement)
  );

  assert.deepEqual(await store.get('token', 0), replacement);
});

test('get returns null for a missing key without calling del', async () => {
  const client = new FakeRedisClient();
  const store = new RedisTokenStore(client, { prefix: 'svc:', now: () => 0 });

  assert.equal(await store.get('missing', 0), null);
  assert.equal(client.delCalls.length, 0);
  assert.equal(client.evalCalls.length, 0);
});

test('atomic consume allows exactly one concurrent caller to receive a record', async () => {
  const client = new FakeRedisClient();
  const store = new RedisTokenStore(client, { prefix: 'atomic:', now: () => 0 });
  const record = sampleRecord();

  await store.set('token', record, 0);

  const [first, second] = await Promise.all([
    store.consume('token', 0),
    store.consume('token', 0)
  ]);

  const received = first === null ? second : first;
  assert.deepEqual(received, record);
  assert.equal(first === null || second === null, true);

  // Both consumers reached the atomic Redis eval path rather than a
  // non-atomic get+del sequence.
  assert.equal(client.evalCalls.length, 2);
  assert.match(client.evalCalls[0].script, /redis\.call/);
  assert.match(client.evalCalls[0].script, /cjson\.decode/);

  assert.equal(client.entries.has('atomic:token'), false);
});

test('consume prevents replay and is exposed by get as consumed', async () => {
  const client = new FakeRedisClient();
  const store = new RedisTokenStore(client, { now: () => 0 });
  const record = sampleRecord();

  await store.set('token', record, 0);

  assert.deepEqual(await store.consume('token', 0), record);
  assert.equal(await store.consume('token', 0), null);
  assert.equal(await store.get('token', 0), null);
});

test('malformed or missing stored values return null without throwing', async () => {
  const client = new FakeRedisClient();
  const store = new RedisTokenStore(client, { prefix: 'bad:', now: () => 0 });

  await client.set('bad:not-json', '{not json', { PX: 100000 });
  await client.set('bad:number', '42', { PX: 100000 });
  await client.set('bad:null', 'null', { PX: 100000 });
  await client.set('bad:string', '"hello"', { PX: 100000 });
  await client.set('bad:array', '[]', { PX: 100000 });
  await client.set(
    'bad:expires',
    JSON.stringify({ token: 'bad:expires', expiresAt: 'soon' }),
    { PX: 100000 }
  );

  for (const token of [
    'not-json',
    'number',
    'null',
    'string',
    'array',
    'expires'
  ]) {
    assert.equal(await store.get(token, 0), null);
    assert.equal(await store.consume(token, 0), null);
  }

  assert.equal(await store.get('missing', 0), null);
  assert.equal(await store.consume('missing', 0), null);
});

test('key prefixes isolate stores that share the same Redis client', async () => {
  const client = new FakeRedisClient({ now: () => 0 });
  const first = new RedisTokenStore(client, { prefix: 'first:', now: () => 0 });
  const second = new RedisTokenStore(client, { prefix: 'second:', now: () => 0 });

  await first.set('token', sampleRecord({ challenge: 'first' }), 0);
  await second.set('token', sampleRecord({ challenge: 'second' }), 0);

  assert.equal((await first.get('token', 0)).challenge, 'first');
  assert.equal((await second.get('token', 0)).challenge, 'second');

  await first.consume('token', 0);

  assert.equal(await first.get('token', 0), null);
  assert.equal((await second.get('token', 0)).challenge, 'second');
  assert.equal(client.entries.has('token'), false);
});

test('RedisTokenStore integrates with createChallengeService', async () => {
  let nowMs = 10_000;
  const now = () => nowMs;
  const client = new FakeRedisClient({ now });
  const store = new RedisTokenStore(client, { prefix: 'svc:', now });
  const service = createChallengeService({
    difficulty: 8,
    ttl: 60_000,
    now,
    store
  });

  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  assert.equal(await service.verifySolution(token, nonce), true);
  assert.equal(await service.verifySolution(token, nonce), false);
  assert.equal(client.evalCalls.length, 1);
});

test('RedisTokenStore atomic consume makes concurrent service verification single-use', async () => {
  const nowMs = 10_000;
  const now = () => nowMs;
  const client = new FakeRedisClient({ now });
  const store = new RedisTokenStore(client, { prefix: 'svc:', now });
  const service = createChallengeService({
    difficulty: 8,
    ttl: 60_000,
    now,
    store
  });

  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  const results = await Promise.all([
    service.verifySolution(token, nonce),
    service.verifySolution(token, nonce)
  ]);

  assert.deepEqual(results.sort(), [false, true]);
});
