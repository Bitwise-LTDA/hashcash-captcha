import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countLeadingZeroBits as browserCountLeadingZeroBits,
  encodeChallengeNonce as browserEncodeChallengeNonce,
  hashChallenge as browserHashChallenge,
  meetsDifficulty as browserMeetsDifficulty,
  sha256Hex as browserSha256Hex,
  solve as browserSolve
} from '../src/pow.browser.js';

import {
  encodeChallengeNonce as serverEncodeChallengeNonce,
  hashChallenge as serverHashChallenge,
  meetsDifficulty as serverMeetsDifficulty,
  sha256Hex as serverSha256Hex,
  verify as serverVerify
} from '../src/pow.js';

const KNOWN_SHA256_ABC =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('browser sha256Hex matches the known SHA-256 vector for "abc"', () => {
  assert.equal(browserSha256Hex('abc'), KNOWN_SHA256_ABC);
  assert.equal(
    browserSha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(browserSha256Hex('abc'), serverSha256Hex('abc'));
});

test('browser encoding and hashing match the server implementation', () => {
  const challenges = [
    'abc',
    '',
    'hashcash-captcha-test',
    'unicode-\u2713-\u2603',
    'a'.repeat(55),
    'b'.repeat(56),
    'c'.repeat(64),
    'd'.repeat(100),
    new Uint8Array([0, 1, 2, 127, 128, 254, 255]),
    Uint8Array.from([0x00, 0x61, 0x62, 0x63])
  ];
  const nonces = [
    0,
    1,
    255,
    256,
    65535,
    65536,
    0x01020304050607,
    Number.MAX_SAFE_INTEGER
  ];

  for (const challenge of challenges) {
    for (const nonce of nonces) {
      const browserEncoded = browserEncodeChallengeNonce(challenge, nonce);
      const serverEncoded = serverEncodeChallengeNonce(challenge, nonce);

      assert.equal(browserEncoded.length, serverEncoded.length);
      assert.equal(
        Buffer.from(browserEncoded).toString('hex'),
        serverEncoded.toString('hex')
      );
      assert.equal(
        browserHashChallenge(challenge, nonce),
        serverHashChallenge(challenge, nonce)
      );
    }
  }
});

test('browser solve finds a nonce accepted by the server verifier', async () => {
  const challenge = 'hashcash-captcha-test';
  const difficulty = 8;
  const nonce = await browserSolve(challenge, difficulty);

  assert.equal(Number.isSafeInteger(nonce), true);
  assert.equal(nonce >= 0, true);
  assert.equal(serverVerify(challenge, nonce, difficulty), true);
  assert.equal(
    browserMeetsDifficulty(browserHashChallenge(challenge, nonce), difficulty),
    true
  );
});

test('browser solve rejects when the attempt limit is exhausted', async () => {
  await assert.rejects(
    browserSolve('abc', 256, { maxAttempts: 5, batchSize: 2 }),
    /no valid nonce found within 5 attempt\(s\) for difficulty 256/
  );
});

test('browser solve yields to the event loop between batches', async () => {
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 0);

  await assert.rejects(
    browserSolve('abc', 256, { maxAttempts: 3, batchSize: 1 }),
    /no valid nonce found within 3 attempt\(s\) for difficulty 256/
  );

  clearTimeout(timer);
  assert.equal(timerRan, true);
});

test('browser solve rejects with AbortError when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    browserSolve('abc', 8, { signal: controller.signal }),
    (error) => error && error.name === 'AbortError'
  );
});

test('browser solve rejects with AbortError when cancelled during a run', async () => {
  const controller = new AbortController();

  const solving = browserSolve('abc', 256, {
    maxAttempts: 1_000_000,
    batchSize: 100,
    signal: controller.signal
  });

  // Let the solver process at least one batch and yield before aborting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();

  await assert.rejects(
    solving,
    (error) => error && error.name === 'AbortError'
  );
});

test('browser solve validates difficulty, nonce, and option ranges', async () => {
  await assert.rejects(browserSolve('abc', -1), RangeError);
  await assert.rejects(browserSolve('abc', 1.5), TypeError);
  await assert.rejects(browserSolve('abc', 257), RangeError);

  await assert.rejects(
    browserSolve('abc', 0, { start: -1 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { maxAttempts: 0 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { maxAttempts: 1.5 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { batchSize: 0 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { batchSize: 1.5 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { signal: {} }),
    TypeError
  );

  assert.throws(() => browserHashChallenge('abc', -1), TypeError);
  assert.throws(() => browserEncodeChallengeNonce('abc', 1.5), TypeError);
  assert.throws(
    () => browserMeetsDifficulty('xyz', 0),
    TypeError
  );
  assert.throws(
    () => browserCountLeadingZeroBits(Buffer.alloc(31, 0)),
    TypeError
  );
});

test('browser solve rejects non-safe-integer solver options before hashing', async () => {
  await assert.rejects(
    browserSolve('abc', 0, { maxAttempts: 1e20 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { maxAttempts: Number.MAX_SAFE_INTEGER + 1 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { batchSize: 1e20 }),
    TypeError
  );
  await assert.rejects(
    browserSolve('abc', 0, { batchSize: Number.MAX_SAFE_INTEGER + 1 }),
    TypeError
  );
});

test('browser solve accepts boundary-safe solver option values', async () => {
  assert.equal(await browserSolve('abc', 0, { maxAttempts: 1 }), 0);
  assert.equal(await browserSolve('abc', 0, { batchSize: 1 }), 0);
  assert.equal(
    await browserSolve('abc', 0, { maxAttempts: Number.MAX_SAFE_INTEGER }),
    0
  );
  assert.equal(
    await browserSolve('abc', 0, { batchSize: Number.MAX_SAFE_INTEGER }),
    0
  );
});
