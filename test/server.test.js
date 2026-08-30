import test from 'node:test';
import assert from 'node:assert/strict';

import { hashChallenge, meetsDifficulty, solve } from '../src/pow.js';
import { createChallengeService, MemoryTokenStore } from '../src/server.js';

function wrongNonce(challenge, difficulty, validNonce) {
  let candidate = validNonce + 1;
  while (meetsDifficulty(hashChallenge(challenge, candidate), difficulty)) {
    candidate += 1;
  }
  return candidate;
}

function nonceThatSolvesFirstButNotSecond(firstChallenge, secondChallenge, difficulty) {
  for (let nonce = 0; nonce <= Number.MAX_SAFE_INTEGER; nonce += 1) {
    if (
      meetsDifficulty(hashChallenge(firstChallenge, nonce), difficulty) &&
      !meetsDifficulty(hashChallenge(secondChallenge, nonce), difficulty)
    ) {
      return nonce;
    }
  }
  throw new Error('unable to find an asymmetric nonce');
}

test('issueChallenge returns token, challenge, difficulty, and expiration time', async () => {
  const now = () => 1_000_000;
  const service = createChallengeService({
    difficulty: 4,
    ttl: 5000,
    now
  });

  const issued = await service.issueChallenge();

  assert.match(issued.token, /^[0-9a-f]{64}$/);
  assert.match(issued.challenge, /^[0-9a-f]{64}$/);
  assert.equal(issued.difficulty, 4);
  assert.equal(issued.expiresAt, 1_005_000);

  const second = await service.issueChallenge();
  assert.notEqual(second.token, issued.token);
  assert.notEqual(second.challenge, issued.challenge);
});

test('issueChallenge rejects an overflowing expiration without writing to the store', async () => {
  const now = () => Number.MAX_VALUE;
  let writes = 0;
  const store = {
    async get() {
      return null;
    },
    async set() {
      writes += 1;
    },
    async consume() {
      return null;
    }
  };

  const service = createChallengeService({
    difficulty: 4,
    ttl: Number.MAX_VALUE,
    now,
    store
  });

  await assert.rejects(service.issueChallenge(), (error) => {
    assert.ok(error instanceof RangeError);
    assert.match(error.message, /expiration/i);
    return true;
  });
  assert.equal(writes, 0);
});

test('verifySolution accepts a correct nonce', async () => {
  const service = createChallengeService({ difficulty: 8 });
  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  assert.equal(await service.verifySolution(token, nonce), true);
});

test('an incorrect nonce does not consume the challenge', async () => {
  const service = createChallengeService({ difficulty: 8 });
  const { token, challenge, difficulty } = await service.issueChallenge();

  const validNonce = solve(challenge, difficulty);
  const invalidNonce = wrongNonce(challenge, difficulty, validNonce);

  assert.equal(await service.verifySolution(token, invalidNonce), false);
  assert.equal(await service.verifySolution(token, validNonce), true);
});

test('verifySolution revalidates the record returned by consume after a replacement race', async () => {
  const difficulty = 4;
  const challengeA = 'record-a';
  const challengeB = 'record-b';
  const nonce = nonceThatSolvesFirstButNotSecond(
    challengeA,
    challengeB,
    difficulty
  );

  assert.equal(meetsDifficulty(hashChallenge(challengeA, nonce), difficulty), true);
  assert.equal(meetsDifficulty(hashChallenge(challengeB, nonce), difficulty), false);

  const now = () => 0;
  const store = {
    async get() {
      return {
        token: 'token',
        challenge: challengeA,
        difficulty,
        createdAt: 0,
        expiresAt: 1000
      };
    },
    async set() {},
    async consume() {
      return {
        token: 'token',
        challenge: challengeB,
        difficulty,
        createdAt: 0,
        expiresAt: 1000
      };
    }
  };

  const service = createChallengeService({ difficulty, now, store });

  assert.equal(await service.verifySolution('token', nonce), false);
});

test('a correct solution consumes the challenge and prevents replay', async () => {
  const service = createChallengeService({ difficulty: 8 });
  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  assert.equal(await service.verifySolution(token, nonce), true);
  assert.equal(await service.verifySolution(token, nonce), false);
});

test('concurrent verification of one valid token allows exactly one success', async () => {
  const service = createChallengeService({ difficulty: 8 });
  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  const results = await Promise.all([
    service.verifySolution(token, nonce),
    service.verifySolution(token, nonce)
  ]);

  assert.deepEqual(results.sort(), [false, true]);
});

test('verifySolution returns false after the challenge expires with an injected clock', async () => {
  let nowMs = 10_000;
  const now = () => nowMs;
  const service = createChallengeService({ difficulty: 8, ttl: 1000, now });

  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  // Issue a second challenge before advancing the clock so both share the
  // same expiration time.
  const second = await service.issueChallenge();
  const secondNonce = solve(second.challenge, second.difficulty);

  nowMs = 10_999;
  assert.equal(await service.verifySolution(token, nonce), true);

  nowMs = 11_000;
  assert.equal(await service.verifySolution(second.token, secondNonce), false);

  nowMs = 12_000;
  assert.equal(await service.verifySolution(second.token, secondNonce), false);
});

test('verifySolution rejects a solution that expires during the get-to-consume gap', async () => {
  let nowMs = 10_000;
  const now = () => nowMs;
  const memory = new MemoryTokenStore({ now });

  let consumeNow;
  const store = {
    async get(token, requestedNow) {
      const record = await memory.get(token, requestedNow);
      // Simulate verification delay: the challenge expires after the
      // preliminary lookup but before the atomic consume.
      nowMs = 11_000;
      return record;
    },
    async set(token, record, requestedNow) {
      return memory.set(token, record, requestedNow);
    },
    async consume(token, requestedNow) {
      consumeNow = requestedNow;
      return memory.consume(token, requestedNow);
    }
  };

  const service = createChallengeService({ difficulty: 4, ttl: 1000, now, store });

  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  assert.equal(await service.verifySolution(token, nonce), false);
  assert.equal(consumeNow, 11_000);
});

test('verifySolution returns false for malformed and unknown submissions without throwing', async () => {
  const service = createChallengeService({ difficulty: 8 });
  const { token, challenge, difficulty } = await service.issueChallenge();
  const nonce = solve(challenge, difficulty);

  for (const badToken of [undefined, null, '', 42, {}, [], true]) {
    assert.equal(await service.verifySolution(badToken, nonce), false);
  }

  for (const badNonce of [
    undefined,
    null,
    -1,
    1.5,
    NaN,
    Infinity,
    '0',
    {},
    [],
    9007199254740992n
  ]) {
    assert.equal(await service.verifySolution(token, badNonce), false);
  }

  assert.equal(await service.verifySolution('missing-token', nonce), false);

  // Malformed attempts must not consume the valid challenge.
  assert.equal(await service.verifySolution(token, nonce), true);
});

test('verifySolution returns false for a malformed stored record without throwing', async () => {
  const now = () => 0;
  const store = new MemoryTokenStore({ now });
  const service = createChallengeService({ difficulty: 8, now, store });

  await store.set(
    'bad-token',
    { token: 'bad-token', challenge: {}, difficulty: '8', expiresAt: 1000 },
    0
  );

  assert.equal(await service.verifySolution('bad-token', 0), false);
});

test('challenge service instances are isolated from each other', async () => {
  const first = createChallengeService({ difficulty: 0 });
  const second = createChallengeService({ difficulty: 0 });

  const firstIssue = await first.issueChallenge();
  const secondIssue = await second.issueChallenge();

  assert.equal(await second.verifySolution(firstIssue.token, 0), false);
  assert.equal(await first.verifySolution(secondIssue.token, 0), false);

  assert.equal(await first.verifySolution(firstIssue.token, 0), true);
  assert.equal(await second.verifySolution(secondIssue.token, 0), true);
});

test('MemoryTokenStore instances are isolated', async () => {
  const now = () => 0;
  const first = new MemoryTokenStore({ now });
  const second = new MemoryTokenStore({ now });

  await first.set(
    'token',
    { token: 'token', challenge: 'challenge', difficulty: 0, expiresAt: 1000 },
    0
  );

  assert.notEqual(await first.get('token', 0), null);
  assert.equal(await second.get('token', 0), null);
});

test('MemoryTokenStore discards expired records when accessed', async () => {
  const store = new MemoryTokenStore({ now: () => 0 });

  await store.set(
    'expired',
    { token: 'expired', challenge: 'challenge', difficulty: 0, expiresAt: 1000 },
    0
  );

  assert.equal(await store.size(999), 1);
  assert.equal(await store.size(1000), 0);
  assert.equal(await store.get('expired', 1000), null);
  assert.equal(await store.consume('expired', 1000), null);
});

test('MemoryTokenStore.get discards malformed records and leaves valid records available', async () => {
  const store = new MemoryTokenStore({ now: () => 0 });
  const validRecord = {
    token: 'valid-token',
    challenge: 'valid-challenge',
    difficulty: 8,
    createdAt: 0,
    expiresAt: 1000
  };

  const cases = [
    ['missing-token', { challenge: 'challenge', difficulty: 8, expiresAt: 1000 }],
    ['empty-token', { token: '', challenge: 'challenge', difficulty: 8, expiresAt: 1000 }],
    ['number-token', { token: 42, challenge: 'challenge', difficulty: 8, expiresAt: 1000 }],
    ['missing-challenge', { token: 'missing-challenge', difficulty: 8, expiresAt: 1000 }],
    ['empty-challenge', { token: 'empty-challenge', challenge: '', difficulty: 8, expiresAt: 1000 }],
    ['object-challenge', { token: 'object-challenge', challenge: {}, difficulty: 8, expiresAt: 1000 }],
    ['missing-difficulty', { token: 'missing-difficulty', challenge: 'challenge', expiresAt: 1000 }],
    ['string-difficulty', { token: 'string-difficulty', challenge: 'challenge', difficulty: '8', expiresAt: 1000 }],
    ['float-difficulty', { token: 'float-difficulty', challenge: 'challenge', difficulty: 8.5, expiresAt: 1000 }],
    ['negative-difficulty', { token: 'negative-difficulty', challenge: 'challenge', difficulty: -1, expiresAt: 1000 }],
    ['high-difficulty', { token: 'high-difficulty', challenge: 'challenge', difficulty: 257, expiresAt: 1000 }]
  ];

  for (const [token, record] of cases) {
    await store.set(token, record, 0);
  }
  await store.set('valid-token', validRecord, 0);

  assert.equal(await store.size(0), cases.length + 1);

  for (const [token] of cases) {
    assert.equal(await store.get(token, 0), null);
    assert.equal(await store.get(token, 0), null);
  }

  assert.equal(await store.size(0), 1);
  const first = await store.get('valid-token', 0);
  assert.deepEqual(first, validRecord);

  first.challenge = 'mutated-after-read';
  assert.equal((await store.get('valid-token', 0)).challenge, 'valid-challenge');
});

test('MemoryTokenStore.consume discards malformed records and leaves valid records consumable', async () => {
  const store = new MemoryTokenStore({ now: () => 0 });
  const validRecord = {
    token: 'valid-token',
    challenge: 'valid-challenge',
    difficulty: 8,
    createdAt: 0,
    expiresAt: 1000
  };

  const cases = [
    ['missing-token', { challenge: 'challenge', difficulty: 8, expiresAt: 1000 }],
    ['empty-token', { token: '', challenge: 'challenge', difficulty: 8, expiresAt: 1000 }],
    ['boolean-token', { token: true, challenge: 'challenge', difficulty: 8, expiresAt: 1000 }],
    ['missing-challenge', { token: 'missing-challenge', difficulty: 8, expiresAt: 1000 }],
    ['empty-challenge', { token: 'empty-challenge', challenge: '', difficulty: 8, expiresAt: 1000 }],
    ['number-challenge', { token: 'number-challenge', challenge: 42, difficulty: 8, expiresAt: 1000 }],
    ['missing-difficulty', { token: 'missing-difficulty', challenge: 'challenge', expiresAt: 1000 }],
    ['null-difficulty', { token: 'null-difficulty', challenge: 'challenge', difficulty: null, expiresAt: 1000 }],
    ['nan-difficulty', { token: 'nan-difficulty', challenge: 'challenge', difficulty: NaN, expiresAt: 1000 }],
    ['infinity-difficulty', { token: 'infinity-difficulty', challenge: 'challenge', difficulty: Infinity, expiresAt: 1000 }],
    ['negative-difficulty', { token: 'negative-difficulty', challenge: 'challenge', difficulty: -1, expiresAt: 1000 }],
    ['high-difficulty', { token: 'high-difficulty', challenge: 'challenge', difficulty: 257, expiresAt: 1000 }]
  ];

  for (const [token, record] of cases) {
    await store.set(token, record, 0);
  }
  await store.set('valid-token', validRecord, 0);

  assert.equal(await store.size(0), cases.length + 1);

  for (const [token] of cases) {
    assert.equal(await store.consume(token, 0), null);
    assert.equal(await store.get(token, 0), null);
  }

  assert.equal(await store.size(0), 1);
  const consumed = await store.consume('valid-token', 0);
  assert.deepEqual(consumed, validRecord);

  consumed.challenge = 'mutated-after-consume';
  assert.equal(await store.get('valid-token', 0), null);
  assert.equal(await store.size(0), 0);
});

test('MemoryTokenStore.set rejects invalid expiresAt values without modifying the store', async () => {
  const nowMs = 1000;
  const store = new MemoryTokenStore({ now: () => nowMs });
  const validRecord = {
    token: 'token',
    challenge: 'challenge',
    difficulty: 0,
    expiresAt: 2000
  };

  await store.set('token', validRecord, nowMs);

  const invalidRecords = [
    {
      name: 'missing',
      record: { token: 'token', challenge: 'challenge', difficulty: 0 }
    },
    {
      name: 'null',
      record: {
        token: 'token',
        challenge: 'challenge',
        difficulty: 0,
        expiresAt: null
      }
    },
    {
      name: 'undefined',
      record: {
        token: 'token',
        challenge: 'challenge',
        difficulty: 0,
        expiresAt: undefined
      }
    },
    {
      name: 'non-number',
      record: {
        token: 'token',
        challenge: 'challenge',
        difficulty: 0,
        expiresAt: '2000'
      }
    },
    {
      name: 'NaN',
      record: {
        token: 'token',
        challenge: 'challenge',
        difficulty: 0,
        expiresAt: NaN
      }
    },
    {
      name: 'Infinity',
      record: {
        token: 'token',
        challenge: 'challenge',
        difficulty: 0,
        expiresAt: Infinity
      }
    },
    {
      name: '-Infinity',
      record: {
        token: 'token',
        challenge: 'challenge',
        difficulty: 0,
        expiresAt: -Infinity
      }
    }
  ];

  for (const { name, record } of invalidRecords) {
    await assert.rejects(
      store.set('token', record, nowMs),
      (error) => {
        assert.ok(error instanceof TypeError, `${name} should throw TypeError`);
        assert.match(error.message, /expiresAt/);
        return true;
      },
      name
    );

    const stored = await store.get('token', nowMs);
    assert.deepEqual(stored, validRecord, `${name} must not replace the stored record`);
    assert.equal(await store.size(nowMs), 1, `${name} must not modify the store`);
  }
});

test('MemoryTokenStore.set discards already-expired records and removes an existing value', async () => {
  const nowMs = 1000;
  const store = new MemoryTokenStore({ now: () => nowMs });

  for (const expiresAt of [999, 1000]) {
    const token = `token-${expiresAt}`;
    const existing = {
      token,
      challenge: 'existing-challenge',
      difficulty: 0,
      expiresAt: 2000
    };

    await store.set(token, existing, nowMs);
    assert.deepEqual(await store.get(token, nowMs), existing);

    await store.set(
      token,
      {
        token,
        challenge: 'already-expired-challenge',
        difficulty: 0,
        expiresAt
      },
      nowMs
    );

    assert.equal(await store.get(token, nowMs), null);
    assert.equal(await store.size(nowMs), 0);
  }
});

test('MemoryTokenStore does not expose mutable stored records', async () => {
  const store = new MemoryTokenStore({ now: () => 0 });
  const record = {
    token: 'token',
    challenge: 'challenge',
    difficulty: 0,
    expiresAt: 1000
  };

  await store.set('token', record, 0);

  record.challenge = 'mutated-after-write';

  const first = await store.get('token', 0);
  assert.equal(first.challenge, 'challenge');

  first.challenge = 'mutated-after-read';

  const second = await store.get('token', 0);
  assert.equal(second.challenge, 'challenge');

  const consumed = await store.consume('token', 0);
  consumed.challenge = 'mutated-after-consume';

  assert.equal(await store.get('token', 0), null);
});

test('createChallengeService validates difficulty, ttl, now, and store', () => {
  assert.throws(() => createChallengeService({ difficulty: -1 }), RangeError);
  assert.throws(() => createChallengeService({ difficulty: 257 }), RangeError);
  assert.throws(() => createChallengeService({ difficulty: 1.5 }), TypeError);
  assert.throws(() => createChallengeService({ difficulty: '8' }), TypeError);
  assert.throws(() => createChallengeService({ difficulty: null }), TypeError);
  assert.throws(() => createChallengeService({ ttl: 0 }), TypeError);
  assert.throws(() => createChallengeService({ ttl: -10 }), TypeError);
  assert.throws(() => createChallengeService({ ttl: NaN }), TypeError);
  assert.throws(() => createChallengeService({ ttl: Infinity }), TypeError);
  assert.throws(() => createChallengeService({ ttl: null }), TypeError);
  assert.throws(() => createChallengeService({ now: 'tomorrow' }), TypeError);
  assert.throws(() => createChallengeService({ now: null }), TypeError);
  assert.throws(() => createChallengeService({ store: {} }), TypeError);
  assert.throws(() => createChallengeService({ store: null }), TypeError);
});
