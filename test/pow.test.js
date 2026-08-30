import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countLeadingZeroBits,
  encodeChallengeNonce,
  hashChallenge,
  meetsDifficulty,
  sha256Hex,
  solve,
  verify
} from '../src/pow.js';

const KNOWN_SHA256_ABC =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('sha256Hex matches the known SHA-256 vector for "abc"', () => {
  assert.equal(sha256Hex('abc'), KNOWN_SHA256_ABC);
});

test('encodeChallengeNonce uses UTF-8 challenge bytes plus fixed 8-byte big-endian nonce', () => {
  const encoded = encodeChallengeNonce('abc', 0x01020304050607);
  const expected = Buffer.from('6162630001020304050607', 'hex');
  assert.deepEqual(encoded, expected);
});

test('hashChallenge is deterministic and nonce-sensitive', () => {
  assert.equal(hashChallenge('abc', 0), hashChallenge('abc', 0));
  assert.equal(
    hashChallenge(Buffer.from('abc'), 0),
    hashChallenge('abc', 0)
  );
  assert.notEqual(hashChallenge('abc', 0), hashChallenge('abc', 1));
});

test('countLeadingZeroBits handles byte-aligned and non-byte-aligned digests', () => {
  assert.equal(countLeadingZeroBits(Buffer.alloc(32, 0)), 256);

  const oneZeroBit = Buffer.alloc(32, 0xff);
  oneZeroBit[0] = 0x7f; // 0b01111111
  assert.equal(countLeadingZeroBits(oneZeroBit), 1);

  const fiveZeroBits = Buffer.alloc(32, 0xff);
  fiveZeroBits[0] = 0x07; // 0b00000111
  assert.equal(countLeadingZeroBits(fiveZeroBits), 5);

  const fifteenZeroBits = Buffer.alloc(32, 0xff);
  fifteenZeroBits[0] = 0x00;
  fifteenZeroBits[1] = 0x01; // 0b00000001
  assert.equal(countLeadingZeroBits(fifteenZeroBits), 15);
});

test('meetsDifficulty evaluates non-byte-aligned leading-zero-bit difficulty', () => {
  const digest = Buffer.alloc(32, 0xff);
  digest[0] = 0x07; // exactly 5 leading zero bits

  assert.equal(meetsDifficulty(digest, 0), true);
  assert.equal(meetsDifficulty(digest, 4), true);
  assert.equal(meetsDifficulty(digest, 5), true);
  assert.equal(meetsDifficulty(digest, 6), false);

  assert.equal(meetsDifficulty(Buffer.alloc(32, 0), 256), true);
  assert.equal(meetsDifficulty(digest, 256), false);
});

test('solve finds a nonce and verify accepts it at a low difficulty', () => {
  const challenge = 'hashcash-captcha-test';
  const difficulty = 8;
  const nonce = solve(challenge, difficulty);

  assert.equal(Number.isSafeInteger(nonce), true);
  assert.equal(nonce >= 0, true);
  assert.equal(meetsDifficulty(hashChallenge(challenge, nonce), difficulty), true);
  assert.equal(verify(challenge, nonce, difficulty), true);
});

test('verify rejects an incorrect nonce', () => {
  const challenge = 'hashcash-captcha-test';
  const difficulty = 8;
  const validNonce = solve(challenge, difficulty);

  // Find a deterministic nonce that does not satisfy the difficulty.
  let wrongNonce = validNonce + 1;
  while (meetsDifficulty(hashChallenge(challenge, wrongNonce), difficulty)) {
    wrongNonce += 1;
  }

  assert.equal(verify(challenge, wrongNonce, difficulty), false);
});

test('difficulty validation rejects negative, non-integer, and >256 values', () => {
  const digest = Buffer.alloc(32, 0);
  for (const invalid of [-1, 1.5, 257, NaN, Infinity, '8', null, undefined]) {
    assert.throws(() => meetsDifficulty(digest, invalid));
  }
});

test('nonce validation rejects invalid values', () => {
  const invalidNonces = [
    -1,
    1.5,
    NaN,
    Infinity,
    '1',
    null,
    undefined,
    Number.MAX_SAFE_INTEGER + 1,
    9007199254740992n
  ];

  for (const nonce of invalidNonces) {
    assert.throws(() => hashChallenge('abc', nonce));
    assert.throws(() => verify('abc', nonce, 0));
  }
  assert.throws(() => solve('abc', 0, { start: -1 }));
});

test('challenge and digest validation reject invalid values', () => {
  for (const invalid of [1, null, undefined, {}, []]) {
    assert.throws(() => hashChallenge(invalid, 0));
  }
  assert.throws(() => meetsDifficulty('xyz', 0));
  assert.throws(() => meetsDifficulty('00'.repeat(31), 0));
  assert.throws(() => meetsDifficulty(Buffer.alloc(31, 0), 0));
});

test('solve honors maxAttempts and throws when no nonce is found', () => {
  assert.throws(() => solve('abc', 256, { maxAttempts: 1 }));
  assert.throws(() => solve('abc', 8, { maxAttempts: 0 }));
  assert.equal(solve('abc', 0, { maxAttempts: 1 }), 0);
});

test('solve rejects non-safe-integer maxAttempts before hashing', () => {
  assert.throws(
    () => solve('abc', 0, { maxAttempts: Number.MAX_SAFE_INTEGER + 1 }),
    TypeError
  );
  assert.throws(
    () => solve('abc', 0, { maxAttempts: 1e20 }),
    TypeError
  );
});

test('solve accepts boundary-safe maxAttempts values', () => {
  assert.equal(solve('abc', 0, { maxAttempts: Number.MAX_SAFE_INTEGER }), 0);
});
