/**
 * Redis-backed token store for the challenge service.
 *
 * This module deliberately imports no Redis client library. Any async
 * Redis-compatible client that implements the minimal injected-client contract
 * documented below can be passed to `RedisTokenStore`:
 *
 *   - `get(key)` resolves to the stored string or `null`.
 *   - `set(key, value, { PX: ttlMs })` stores `value` with a millisecond TTL.
 *   - `del(key)` resolves after deleting `key`.
 *   - `eval(script, { keys, arguments })` evaluates a Lua script atomically.
 *
 * This is the shape used by `node-redis` v4+. Other clients can be wrapped in
 * a thin adapter.
 */

const CONSUME_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local raw = redis.call('GET', key)
if not raw then
  return nil
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' then
  redis.call('DEL', key)
  return nil
end
local expiresAt = record['expiresAt']
if type(expiresAt) ~= 'number' or expiresAt <= now then
  redis.call('DEL', key)
  return nil
end
redis.call('DEL', key)
return raw
`;

const COMPARE_AND_DELETE_SCRIPT = `
local key = KEYS[1]
local expected = ARGV[1]
local current = redis.call('GET', key)
if current == expected then
  redis.call('DEL', key)
end
return current
`;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isDifficultyValid(value) {
  return Number.isInteger(value) && value >= 0 && value <= 256;
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

function toTimestamp(value, fallbackNow) {
  const nowMs = value === undefined ? callNow(fallbackNow) : value;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(
      'nowMs must be a finite timestamp in milliseconds'
    );
  }
  return nowMs;
}

function assertClient(client) {
  if (!isRecord(client)) {
    throw new TypeError(
      'client must implement the async Redis client interface'
    );
  }
  for (const method of ['get', 'set', 'del', 'eval']) {
    if (typeof client[method] !== 'function') {
      throw new TypeError(`client must implement async ${method}()`);
    }
  }
}

function assertToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token must be a non-empty string');
  }
}

function assertRecord(record) {
  if (!isRecord(record)) {
    throw new TypeError('record must be an object');
  }
}

/**
 * Redis-backed implementation of the challenge service's asynchronous
 * token-store contract (`get`, `set`, and `consume`).
 *
 * @param {object} client Async Redis-compatible client implementing the
 *   injected-client contract described at the top of this module.
 * @param {object} [options]
 * @param {string} [options.prefix=''] Key prefix prepended to every Redis key.
 * @param {Function} [options.now] Function returning epoch milliseconds.
 *   Defaults to `Date.now`.
 */
export class RedisTokenStore {
  #client;
  #prefix;
  #now;

  constructor(client, options = {}) {
    assertClient(client);

    const { prefix = '', now } = options ?? {};
    if (typeof prefix !== 'string') {
      throw new TypeError('prefix must be a string');
    }

    this.#client = client;
    this.#prefix = prefix;
    this.#now = resolveNow(now);
  }

  #key(token) {
    return this.#prefix + token;
  }

  #decode(raw, nowMs) {
    if (raw === null || raw === undefined) {
      return null;
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return null;
    }

    if (
      !isRecord(record) ||
      isExpired(record, nowMs) ||
      !isNonEmptyString(record.token) ||
      !isNonEmptyString(record.challenge) ||
      !isDifficultyValid(record.difficulty)
    ) {
      return null;
    }
    return cloneRecord(record);
  }

  /** Return a copy of the record for `token`, or `null` if absent/expired. */
  async get(token, nowMs) {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    const now = toTimestamp(nowMs, this.#now);
    const key = this.#key(token);
    const raw = await this.#client.get(key);
    if (raw === null || raw === undefined) {
      return null;
    }

    const record = this.#decode(raw, now);
    if (record === null) {
      // Match the consume path: once we observe a malformed or logically
      // expired value, remove it so it cannot be returned again. Compare and
      // delete atomically so a value written after our GET is never removed.
      await this.#client.eval(COMPARE_AND_DELETE_SCRIPT, {
        keys: [key],
        arguments: [raw]
      });
      return null;
    }
    return record;
  }

  /** Store a serialized copy of `record` under `token` with a Redis TTL. */
  async set(token, record, nowMs) {
    assertToken(token);
    assertRecord(record);

    const now = toTimestamp(nowMs, this.#now);
    const { expiresAt } = record;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      throw new TypeError(
        'record.expiresAt must be a finite timestamp in milliseconds'
      );
    }

    const ttlMs = expiresAt - now;
    const key = this.#key(token);

    if (ttlMs <= 0) {
      // An already-expired record should not leave a previous value behind.
      await this.#client.del(key);
      return;
    }

    // `Math.ceil` keeps the key alive through the full record lifetime when
    // `nowMs` or `expiresAt` includes sub-millisecond precision.
    await this.#client.set(key, JSON.stringify(record), {
      PX: Math.ceil(ttlMs)
    });
  }

  /**
   * Atomically remove and return a copy of the record for `token`, or `null`
   * when the token is absent/expired. Atomicity comes from a Lua script run
   * through the injected client, so concurrent consumers of the same token
   * cannot both receive a record.
   */
  async consume(token, nowMs) {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    const now = toTimestamp(nowMs, this.#now);
    const raw = await this.#client.eval(CONSUME_SCRIPT, {
      keys: [this.#key(token)],
      arguments: [String(now)]
    });
    return this.#decode(raw, now);
  }
}
