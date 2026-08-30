/**
 * Browser-compatible SHA-256 proof-of-work fallback.
 *
 * This module has no Node.js imports and no runtime dependencies. It uses the
 * same canonical challenge-plus-8-byte-nonce encoding as `src/pow.js`:
 *
 *   1. A challenge is accepted as a UTF-8 string, `Uint8Array`, or
 *      `ArrayBuffer`. Strings are encoded as UTF-8 bytes and byte inputs are
 *      copied byte-for-byte.
 *   2. A nonce must be a non-negative safe integer
 *      (`0 <= nonce <= Number.MAX_SAFE_INTEGER`).
 *   3. The bytes that are hashed are the challenge bytes followed by the nonce
 *      as an unsigned 8-byte big-endian value.
 *
 * The `solve` function is asynchronous and yields to the event loop between
 * bounded batches so a run can be cancelled cooperatively with an
 * `AbortSignal`.
 */

const SHA256_BYTE_LENGTH = 32;
const NONCE_BYTE_LENGTH = 8;
const MAX_NONCE = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_ATTEMPTS = 1_000_000;
const DEFAULT_BATCH_SIZE = 4096;

// SHA-256 round constants.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

/** Compute SHA-256 over a byte array and return a 32-byte Uint8Array. */
function sha256Bytes(bytes) {
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes, 0);
  padded[bytes.length] = 0x80;

  // Append the original bit length as an unsigned 64-bit big-endian integer.
  const view = new DataView(padded.buffer);
  view.setBigUint64(paddedLength - 8, BigInt(bytes.length) * 8n, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = (
        (padded[j] << 24) |
        (padded[j + 1] << 16) |
        (padded[j + 2] << 8) |
        padded[j + 3]
      ) >>> 0;
    }

    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + K[i] + w[i]) | 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const digest = new Uint8Array(SHA256_BYTE_LENGTH);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, h0 >>> 0, false);
  digestView.setUint32(4, h1 >>> 0, false);
  digestView.setUint32(8, h2 >>> 0, false);
  digestView.setUint32(12, h3 >>> 0, false);
  digestView.setUint32(16, h4 >>> 0, false);
  digestView.setUint32(20, h5 >>> 0, false);
  digestView.setUint32(24, h6 >>> 0, false);
  digestView.setUint32(28, h7 >>> 0, false);
  return digest;
}

function copyBytes(bytes) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes, 0);
  return copy;
}

/** Convert a public challenge value into a byte Uint8Array. */
function toChallengeBytes(challenge) {
  if (typeof challenge === 'string') {
    return new TextEncoder().encode(challenge);
  }
  if (challenge instanceof Uint8Array) {
    return copyBytes(challenge);
  }
  if (challenge instanceof ArrayBuffer) {
    return new Uint8Array(challenge.slice(0));
  }
  throw new TypeError(
    'challenge must be a string, Uint8Array, or ArrayBuffer'
  );
}

/** Validate a nonce value and throw when it is not usable. */
function assertNonce(nonce) {
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw new TypeError('nonce must be a non-negative safe integer');
  }
}

/** Validate a leading-zero-bit difficulty value. */
function assertDifficulty(difficulty) {
  if (typeof difficulty !== 'number' || !Number.isInteger(difficulty)) {
    throw new TypeError('difficulty must be an integer between 0 and 256');
  }
  if (difficulty < 0 || difficulty > 256) {
    throw new RangeError('difficulty must be between 0 and 256');
  }
}

/** Validate a positive safe-integer solver option such as maxAttempts or batchSize. */
function assertPositiveInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

/** Convert a public digest value into a 32-byte Uint8Array. */
function toDigestBytes(digest) {
  if (typeof digest === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
      throw new TypeError(
        'digest string must be exactly 64 hexadecimal characters'
      );
    }
    const bytes = new Uint8Array(SHA256_BYTE_LENGTH);
    for (let i = 0; i < SHA256_BYTE_LENGTH; i += 1) {
      bytes[i] = parseInt(digest.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  if (digest instanceof Uint8Array) {
    const bytes = copyBytes(digest);
    if (bytes.length !== SHA256_BYTE_LENGTH) {
      throw new TypeError(
        'digest must contain exactly 32 bytes (SHA-256 output length)'
      );
    }
    return bytes;
  }
  if (digest instanceof ArrayBuffer) {
    const bytes = new Uint8Array(digest.slice(0));
    if (bytes.length !== SHA256_BYTE_LENGTH) {
      throw new TypeError(
        'digest must contain exactly 32 bytes (SHA-256 output length)'
      );
    }
    return bytes;
  }
  throw new TypeError(
    'digest must be a 64-character hex string, Uint8Array, or ArrayBuffer'
  );
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Encode a challenge and nonce into the canonical byte sequence that is hashed
 * by this module.
 *
 * @param {string|Uint8Array|ArrayBuffer} challenge
 * @param {number} nonce Non-negative safe integer.
 * @returns {Uint8Array} Challenge bytes followed by the 8-byte big-endian nonce.
 */
export function encodeChallengeNonce(challenge, nonce) {
  assertNonce(nonce);
  const challengeBytes = toChallengeBytes(challenge);
  const encoded = new Uint8Array(challengeBytes.length + NONCE_BYTE_LENGTH);
  encoded.set(challengeBytes, 0);
  const view = new DataView(encoded.buffer);
  view.setBigUint64(challengeBytes.length, BigInt(nonce), false);
  return encoded;
}

/**
 * Compute the SHA-256 digest of a string or byte input.
 *
 * @param {string|Uint8Array|ArrayBuffer} data
 * @returns {string} Lowercase hexadecimal SHA-256 digest.
 */
export function sha256Hex(data) {
  return bytesToHex(sha256Bytes(toChallengeBytes(data)));
}

/**
 * Compute the SHA-256 digest of a canonical challenge-plus-nonce encoding.
 *
 * @param {string|Uint8Array|ArrayBuffer} challenge
 * @param {number} nonce Non-negative safe integer.
 * @returns {string} Lowercase hexadecimal SHA-256 digest.
 */
export function hashChallenge(challenge, nonce) {
  return bytesToHex(sha256Bytes(encodeChallengeNonce(challenge, nonce)));
}

/**
 * Count the number of leading zero bits in a SHA-256 digest.
 *
 * @param {string|Uint8Array|ArrayBuffer} digest
 * @returns {number} Integer from 0 to 256 inclusive.
 */
export function countLeadingZeroBits(digest) {
  const bytes = toDigestBytes(digest);
  let bits = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
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
 * @param {string|Uint8Array|ArrayBuffer} digest
 * @param {number} difficulty Integer from 0 to 256 inclusive.
 * @returns {boolean}
 */
export function meetsDifficulty(digest, difficulty) {
  assertDifficulty(difficulty);
  return countLeadingZeroBits(digest) >= difficulty;
}

function createAbortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted', 'AbortError');
  }
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal !== undefined && signal !== null && signal.aborted) {
    throw createAbortError();
  }
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Asynchronously solve for the smallest valid nonce starting at
 * `options.start`.
 *
 * @param {string|Uint8Array|ArrayBuffer} challenge
 * @param {number} difficulty Integer from 0 to 256 inclusive.
 * @param {object} [options]
 * @param {number} [options.start=0] Non-negative safe integer to start from.
 * @param {number} [options.maxAttempts=1000000] Maximum nonce values to try.
 * @param {number} [options.batchSize=4096] Hashes before yielding to the event
 *   loop.
 * @param {AbortSignal} [options.signal] Cancellation signal.
 * @returns {Promise<number>} A nonce whose challenge hash meets the difficulty.
 */
export async function solve(challenge, difficulty, options = {}) {
  assertDifficulty(difficulty);
  const challengeBytes = toChallengeBytes(challenge);

  const {
    start = 0,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    batchSize = DEFAULT_BATCH_SIZE,
    signal = undefined
  } = options ?? {};

  assertNonce(start);
  assertPositiveInteger(maxAttempts, 'maxAttempts');
  assertPositiveInteger(batchSize, 'batchSize');
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')
  ) {
    throw new TypeError('signal must be an AbortSignal or undefined');
  }

  throwIfAborted(signal);

  let nonce = start;
  let attempts = 0;

  while (attempts < maxAttempts && nonce <= MAX_NONCE) {
    throwIfAborted(signal);

    const remainingAttempts = maxAttempts - attempts;
    const remainingNonces = MAX_NONCE - nonce + 1;
    const batch = Math.min(batchSize, remainingAttempts, remainingNonces);

    for (let i = 0; i < batch; i += 1) {
      const encoded = new Uint8Array(challengeBytes.length + NONCE_BYTE_LENGTH);
      encoded.set(challengeBytes, 0);
      const view = new DataView(encoded.buffer);
      view.setBigUint64(challengeBytes.length, BigInt(nonce), false);

      const digest = sha256Bytes(encoded);
      if (countLeadingZeroBits(digest) >= difficulty) {
        return nonce;
      }

      nonce += 1;
      attempts += 1;
    }

    if (attempts < maxAttempts && nonce <= MAX_NONCE) {
      await yieldToEventLoop();
    }
  }

  throw new Error(
    `no valid nonce found within ${maxAttempts} attempt(s) for difficulty ${difficulty}`
  );
}
