import { createHash } from 'node:crypto';

/**
 * Minimal SHA-256 proof-of-work primitives for nonce-based challenges.
 *
 * Encoding contract
 * -----------------
 * A challenge is accepted as a string, a Buffer, or a Uint8Array.
 *   - Strings are encoded as UTF-8 bytes.
 *   - Buffers and Uint8Arrays are used as-is (byte-for-byte).
 * A nonce must be a non-negative safe integer (0 <= nonce <=
 * Number.MAX_SAFE_INTEGER). It is appended to the challenge bytes as an
 * unsigned 8-byte big-endian value. Because the nonce field has a fixed
 * width, every distinct (challenge, nonce) pair maps to a distinct byte
 * sequence and therefore always produces the same SHA-256 digest.
 */

const SHA256_BYTE_LENGTH = 32;
const NONCE_BYTE_LENGTH = 8;
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

/** Convert a public challenge value into a byte Buffer. */
function toChallengeBytes(challenge) {
  if (typeof challenge === 'string') {
    return Buffer.from(challenge, 'utf8');
  }
  if (Buffer.isBuffer(challenge)) {
    return Buffer.from(challenge);
  }
  if (challenge instanceof Uint8Array) {
    return Buffer.from(challenge);
  }
  throw new TypeError(
    'challenge must be a string, Buffer, or Uint8Array'
  );
}

/** Validate a nonce value and throw when it is not usable. */
function assertNonce(nonce) {
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw new TypeError(
      'nonce must be a non-negative safe integer'
    );
  }
}

/** Validate a leading-zero-bit difficulty value. */
function assertDifficulty(difficulty) {
  if (typeof difficulty !== 'number' || !Number.isInteger(difficulty)) {
    throw new TypeError(
      'difficulty must be an integer between 0 and 256'
    );
  }
  if (difficulty < 0 || difficulty > 256) {
    throw new RangeError(
      'difficulty must be between 0 and 256'
    );
  }
}

/** Convert a public digest value into a 32-byte Buffer. */
function toDigestBytes(digest) {
  if (typeof digest === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
      throw new TypeError(
        'digest string must be exactly 64 hexadecimal characters'
      );
    }
    return Buffer.from(digest, 'hex');
  }
  if (Buffer.isBuffer(digest)) {
    digest = Buffer.from(digest);
  } else if (digest instanceof Uint8Array) {
    digest = Buffer.from(digest);
  } else {
    throw new TypeError(
      'digest must be a 64-character hex string, Buffer, or Uint8Array'
    );
  }
  if (digest.length !== SHA256_BYTE_LENGTH) {
    throw new TypeError(
      'digest must contain exactly 32 bytes (SHA-256 output length)'
    );
  }
  return digest;
}

/**
 * Encode a challenge and nonce into the canonical byte sequence that is
 * hashed by this module.
 *
 * @param {string|Buffer|Uint8Array} challenge
 * @param {number} nonce Non-negative safe integer.
 * @returns {Buffer} challenge bytes followed by the 8-byte big-endian nonce.
 */
export function encodeChallengeNonce(challenge, nonce) {
  assertNonce(nonce);
  const challengeBytes = toChallengeBytes(challenge);
  const encoded = Buffer.alloc(challengeBytes.length + NONCE_BYTE_LENGTH);
  challengeBytes.copy(encoded, 0);
  encoded.writeBigUInt64BE(BigInt(nonce), challengeBytes.length);
  return encoded;
}

/**
 * Compute the SHA-256 digest of a string, Buffer, or Uint8Array.
 *
 * @param {string|Buffer|Uint8Array} data
 * @returns {string} Lowercase hexadecimal SHA-256 digest.
 */
export function sha256Hex(data) {
  return createHash('sha256').update(toChallengeBytes(data)).digest('hex');
}

/**
 * Compute the SHA-256 digest of a canonical challenge-plus-nonce encoding.
 *
 * @param {string|Buffer|Uint8Array} challenge
 * @param {number} nonce Non-negative safe integer.
 * @returns {string} Lowercase hexadecimal SHA-256 digest.
 */
export function hashChallenge(challenge, nonce) {
  return createHash('sha256')
    .update(encodeChallengeNonce(challenge, nonce))
    .digest('hex');
}

/**
 * Count the number of leading zero bits in a SHA-256 digest.
 *
 * @param {string|Buffer|Uint8Array} digest
 * @returns {number} Integer from 0 to 256 inclusive.
 */
export function countLeadingZeroBits(digest) {
  const bytes = toDigestBytes(digest);
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    let mask = 0x80;
    while (mask !== 0 && (byte & mask) === 0) {
      bits += 1;
      mask >>= 1;
    }
    break;
  }
  return bits;
}

/**
 * Test whether a digest satisfies an integer leading-zero-bit difficulty.
 *
 * @param {string|Buffer|Uint8Array} digest
 * @param {number} difficulty Integer from 0 to 256 inclusive.
 * @returns {boolean}
 */
export function meetsDifficulty(digest, difficulty) {
  assertDifficulty(difficulty);
  return countLeadingZeroBits(digest) >= difficulty;
}

/**
 * Solve for the smallest valid nonce starting at `options.start`.
 *
 * @param {string|Buffer|Uint8Array} challenge
 * @param {number} difficulty Integer from 0 to 256 inclusive.
 * @param {object} [options]
 * @param {number} [options.start=0] Non-negative safe integer to start from.
 * @param {number} [options.maxAttempts=1000000] Maximum nonce values to try.
 * @returns {number} A nonce whose challenge hash meets the difficulty.
 */
export function solve(challenge, difficulty, options = {}) {
  assertDifficulty(difficulty);
  toChallengeBytes(challenge);

  const {
    start = 0,
    maxAttempts = 1_000_000
  } = options ?? {};

  assertNonce(start);
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new TypeError('maxAttempts must be a positive safe integer');
  }

  for (let nonce = start; nonce <= MAX_NONCE; nonce += 1) {
    if (nonce - start >= maxAttempts) {
      break;
    }
    const digest = hashChallenge(challenge, nonce);
    if (countLeadingZeroBits(digest) >= difficulty) {
      return nonce;
    }
  }

  throw new Error(
    `no valid nonce found within ${maxAttempts} attempt(s) for difficulty ${difficulty}`
  );
}

/**
 * Verify that a submitted nonce satisfies a challenge difficulty.
 *
 * @param {string|Buffer|Uint8Array} challenge
 * @param {number} nonce Non-negative safe integer.
 * @param {number} difficulty Integer from 0 to 256 inclusive.
 * @returns {boolean}
 */
export function verify(challenge, nonce, difficulty) {
  assertNonce(nonce);
  assertDifficulty(difficulty);
  const digest = hashChallenge(challenge, nonce);
  return countLeadingZeroBits(digest) >= difficulty;
}
