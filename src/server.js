import { randomBytes } from 'node:crypto';

import { verify as verifyProof } from './pow.js';

/**
 * Framework-agnostic, instance-based challenge service.
 *
 * A service issues short-lived proof-of-work challenges and verifies submitted
 * solutions. All per-service state is owned by the injected token store; the
 * module itself keeps no global state and does not depend on a web framework.
 *
 * Token-store contract
 * --------------------
 * A store is an object with the following asynchronous methods:
 *
 *   - `get(token, nowMs?)` returns a Promise resolving to a copy of the stored
 *     record, or `null` when the token is unknown or has expired. Expired
 *     records should be discarded when they are observed.
 *   - `set(token, record, nowMs?)` stores `record` under `token` and resolves
 *     when the write is durable.
 *   - `consume(token, nowMs?)` atomically removes and returns a copy of the
 *     stored record, or resolves to `null` when the token is unknown or has
 *     expired. Atomic removal is what makes single-use verification safe under
 *     concurrency, so a Redis implementation must make this operation atomic
 *     (for example with a Lua script).
 *
 * `nowMs` is an optional epoch-millisecond timestamp. It lets the service
 * inject the same clock into the store and makes expiration deterministic in
 * tests. Implementations may fall back to their own clock when it is omitted.
 *
 * Record shape:
 *
 *   {
 *     token: string,       // hex token returned to the caller
 *     challenge: string,   // hex challenge solved by the browser
 *     difficulty: number,  // leading-zero-bit difficulty, 0 through 256
 *     createdAt: number,   // epoch milliseconds when the record was created
 *     expiresAt: number    // epoch milliseconds when the record expires
 *   }
 */

const DEFAULT_DIFFICULTY = 16;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_BYTES = 32;
const DEFAULT_CHALLENGE_BYTES = 32;

function assertDifficulty(difficulty) {
  if (typeof difficulty !== 'number' || !Number.isInteger(difficulty)) {
    throw new TypeError('difficulty must be an integer between 0 and 256');
  }
  if (difficulty < 0 || difficulty > 256) {
    throw new RangeError('difficulty must be between 0 and 256');
  }
}

function assertTtl(ttl) {
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
    throw new TypeError(
      'ttl must be a positive finite number of milliseconds'
    );
  }
}

function resolveNow(now) {
  if (now === undefined) {
    return Date.now;
  }
  if (typeof now !== 'function') {
    throw new TypeError(
      'now must be a function returning a timestamp in milliseconds'
    );
  }
  return now;
}

function callNow(now) {
  const value = now();
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      'now must return a finite timestamp in milliseconds'
    );
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isDifficultyValid(value) {
  return Number.isInteger(value) && value >= 0 && value <= 256;
}

function isValidChallengeRecord(record) {
  return (
    isRecord(record) &&
    isNonEmptyString(record.token) &&
    isNonEmptyString(record.challenge) &&
    isDifficultyValid(record.difficulty)
  );
}

function cloneRecord(record) {
  return { ...record };
}

function isExpired(record, nowMs) {
  if (!isRecord(record)) {
    return true;
  }
  const { expiresAt } = record;
  return (
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= nowMs
  );
}

function toTimestamp(value, fallbackNow) {
  const nowMs = value === undefined ? fallbackNow() : value;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(
      'nowMs must be a finite timestamp in milliseconds'
    );
  }
  return nowMs;
}

function assertStore(store) {
  if (!isRecord(store)) {
    throw new TypeError(
      'store must implement the asynchronous token-store interface'
    );
  }
  for (const method of ['get', 'set', 'consume']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`store must implement async ${method}()`);
    }
  }
}

/**
 * In-memory token store for the challenge service.
 *
 * Each instance owns a private `Map`, so instances never share records.
 * Expired records are pruned when any record is read, written, consumed, or
 * counted. Reads and consumes discard malformed challenge records and return
 * copies, never the internal record objects.
 */
export class MemoryTokenStore {
  #records;
  #now;

  constructor(options = {}) {
    this.#records = new Map();
    const { now } = options ?? {};
    this.#now = resolveNow(now);
  }

  #discardExpired(nowMs) {
    for (const [token, record] of this.#records) {
      if (isExpired(record, nowMs)) {
        this.#records.delete(token);
      }
    }
  }

  /** Return a copy of the record for `token`, or `null` if absent/expired. */
  async get(token, nowMs) {
    const now = toTimestamp(nowMs, this.#now);
    this.#discardExpired(now);
    const record = this.#records.get(token);
    if (record === undefined) {
      return null;
    }
    if (!isValidChallengeRecord(record)) {
      this.#records.delete(token);
      return null;
    }
    return cloneRecord(record);
  }

  /** Store a copy of `record` under `token`. */
  async set(token, record, nowMs) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('token must be a non-empty string');
    }
    if (!isRecord(record)) {
      throw new TypeError('record must be an object');
    }
    const now = toTimestamp(nowMs, this.#now);
    const { expiresAt } = record;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      throw new TypeError(
        'record.expiresAt must be a finite timestamp in milliseconds'
      );
    }
    this.#discardExpired(now);
    if (expiresAt <= now) {
      // An already-expired record should not leave a previous value behind.
      this.#records.delete(token);
      return;
    }
    this.#records.set(token, cloneRecord(record));
  }

  /**
   * Atomically remove and return a copy of the record for `token`, or `null`
   * when the token is absent/expired. The body runs synchronously, so two
   * callers can never both consume the same record.
   */
  async consume(token, nowMs) {
    const now = toTimestamp(nowMs, this.#now);
    this.#discardExpired(now);
    const record = this.#records.get(token);
    if (record === undefined) {
      return null;
    }
    if (!isValidChallengeRecord(record)) {
      this.#records.delete(token);
      return null;
    }
    this.#records.delete(token);
    return cloneRecord(record);
  }

  /**
   * Return the number of unexpired records after pruning expired entries.
   * This is a `MemoryTokenStore` convenience; it is not required by the
   * service's token-store contract.
   */
  async size(nowMs) {
    const now = toTimestamp(nowMs, this.#now);
    this.#discardExpired(now);
    return this.#records.size;
  }
}

/**
 * Create an independent challenge service.
 *
 * @param {object} [options]
 * @param {number} [options.difficulty=16] Leading-zero-bit difficulty, 0-256.
 * @param {number} [options.ttl=300000] Challenge lifetime in milliseconds.
 * @param {Function} [options.now] Function returning epoch milliseconds.
 *   Defaults to `Date.now`.
 * @param {object} [options.store] Asynchronous token store. Defaults to a new
 *   `MemoryTokenStore` that shares the configured clock.
 * @returns {{ issueChallenge: Function, verifySolution: Function }}
 */
export function createChallengeService(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const difficulty =
    options.difficulty === undefined ? DEFAULT_DIFFICULTY : options.difficulty;
  assertDifficulty(difficulty);

  const ttl = options.ttl === undefined ? DEFAULT_TTL_MS : options.ttl;
  assertTtl(ttl);

  const now = resolveNow(options.now);
  const store =
    options.store === undefined ? new MemoryTokenStore({ now }) : options.store;
  assertStore(store);

  return {
    /**
     * Create and store a new challenge.
     *
     * @returns {Promise<{token: string, challenge: string, difficulty: number,
     *   expiresAt: number}>} Values needed by a browser solver.
     */
    async issueChallenge() {
      const nowMs = callNow(now);
      const expiresAt = nowMs + ttl;
      if (!Number.isFinite(expiresAt)) {
        throw new RangeError(
          'computed challenge expiration is not finite; ttl is too large for the current time'
        );
      }

      const token = randomBytes(DEFAULT_TOKEN_BYTES).toString('hex');
      const challenge = randomBytes(DEFAULT_CHALLENGE_BYTES).toString('hex');

      const record = {
        token,
        challenge,
        difficulty,
        createdAt: nowMs,
        expiresAt
      };

      await store.set(token, record, nowMs);

      return {
        token,
        challenge,
        difficulty,
        expiresAt: record.expiresAt
      };
    },

    /**
     * Verify a submitted solution.
     *
     * The challenge record is consumed only when the nonce is correct. The
     * store's atomic `consume` guarantees that concurrent verification of the
     * same token succeeds for exactly one caller.
     *
     * A preliminary check against `store.get()` avoids consuming a record for
     * an obviously wrong nonce. The returned value is then revalidated against
     * the record actually removed by `store.consume()`, so a replacement that
     * races with the initial read can never make an incorrect solution pass.
     *
     * @param {string} token Token returned by `issueChallenge`.
     * @param {number} nonce Non-negative safe integer submitted by the solver.
     * @returns {Promise<boolean>} `true` only for the first correct solution;
     *   `false` for unknown, expired, malformed, or incorrect submissions.
     */
    async verifySolution(token, nonce) {
      try {
        if (typeof token !== 'string' || token.length === 0) {
          return false;
        }
        if (
          typeof nonce !== 'number' ||
          !Number.isSafeInteger(nonce) ||
          nonce < 0
        ) {
          return false;
        }

        const nowMs = callNow(now);
        const record = await store.get(token, nowMs);
        if (!isRecord(record)) {
          return false;
        }

        if (!verifyProof(record.challenge, nonce, record.difficulty)) {
          return false;
        }

        const consumeNowMs = callNow(now);
        const consumed = await store.consume(token, consumeNowMs);
        if (!isRecord(consumed)) {
          return false;
        }

        return verifyProof(consumed.challenge, nonce, consumed.difficulty);
      } catch {
        return false;
      }
    }
  };
}
