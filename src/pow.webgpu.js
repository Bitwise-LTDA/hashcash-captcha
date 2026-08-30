/**
 * Browser-only WebGPU SHA-256 proof-of-work solver.
 *
 * This module has no Node.js imports and no runtime dependencies. It uses the
 * same canonical challenge-plus-8-byte-nonce encoding as `src/pow.js` and
 * `src/pow.browser.js`:
 *
 *   1. A challenge is accepted as a UTF-8 string, `Uint8Array`, or
 *      `ArrayBuffer`. Strings are encoded as UTF-8 bytes and byte inputs are
 *      copied byte-for-byte.
 *   2. A nonce must be a non-negative safe integer
 *      (`0 <= nonce <= Number.MAX_SAFE_INTEGER`).
 *   3. The bytes that are hashed are the challenge bytes followed by the nonce
 *      as an unsigned 8-byte big-endian value.
 *
 * `solveWebGpu` searches bounded nonce ranges in parallel on the GPU. Each
 * compute dispatch produces one small result buffer containing either the
 * winning nonce or a not-found sentinel; per-attempt digests and attempted
 * nonces are never copied back to JavaScript. Before resolving, the returned
 * nonce is verified with the dependency-free browser SHA-256 implementation
 * from `./pow.browser.js`, so an invalid GPU result rejects instead of being
 * silently returned.
 */

import {
  hashChallenge,
  meetsDifficulty,
  solve as browserSolve
} from './pow.browser.js';

const WORKGROUP_SIZE = 256;
const PARAMS_WORDS = 8;
const PARAMS_BYTES = PARAMS_WORDS * 4;
const SOLVE_RESULT_WORDS = 3;
const SOLVE_RESULT_BYTES = SOLVE_RESULT_WORDS * 4;
const DIGEST_WORDS = 8;
const DIGEST_BYTES = DIGEST_WORDS * 4;

const MODE_HASH = 0;
const MODE_SOLVE = 1;

const DEFAULT_MAX_ATTEMPTS = 1_000_000;
const DEFAULT_BATCH_SIZE = 262_144;
const MAX_NONCE = Number.MAX_SAFE_INTEGER;
const MAX_CHALLENGE_BYTES = 0x0fffffff; // Keeps the WGSL 32-bit bit-length math from overflowing.

// WebGPU numeric constants. The numeric values match the WebGPU IDL so this
// module works in browsers and in test harnesses that do not expose the
// `GPUBufferUsage`/`GPUShaderStage` globals.
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_STORAGE = 0x0080;
const SHADER_STAGE_COMPUTE = 0x0004;
const MAP_MODE_READ = 0x0001;

const SOLVE_RESULT_NOT_FOUND = new Uint32Array([0, 0xffffffff, 0xffffffff]);

/**
 * WGSL compute shader.
 *
 * It has two entry points that share one SHA-256 implementation:
 *   - `solve`: hashes challenge + nonce for every invocation in a bounded
 *     range and atomically records the first winner.
 *   - `hash`: hashes one byte buffer and writes the 32-byte digest. This is
 *     used by `sha256WebGpu` and by the browser parity tests.
 *
 * The data buffer is an array of one `u32` per input byte. The nonce is split
 * into two 32-bit words so the full JavaScript safe-integer nonce range is
 * supported without WGSL 64-bit integers.
 */
export const SHA256_CODE = `
const K: array<u32, 64> = array<u32, 64>(
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
  0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
  0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
  0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
  0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
  0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
  0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
  0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
  0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
  0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
  0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
  0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
);

struct Params {
  dataLength: u32,
  baseNonceLo: u32,
  baseNonceHi: u32,
  difficulty: u32,
  dispatchSize: u32,
  mode: u32,
  padding0: u32,
  padding1: u32,
};

struct SolveResult {
  flag: atomic<u32>,
  nonceHi: atomic<u32>,
  nonceLo: atomic<u32>,
};

@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> solveResult: SolveResult;
@group(0) @binding(3) var<storage, read_write> digestResult: array<u32, 8>;

fn rotr(value: u32, shift: u32) -> u32 {
  return (value >> shift) | (value << (32u - shift));
}

fn readByte(index: u32, p: Params) -> u32 {
  let dataLength = p.dataLength;
  if (index < dataLength) {
    return data[index];
  }

  if (p.mode == 1u) {
    let nonceIndex = index - dataLength;
    if (nonceIndex < 8u) {
      if (nonceIndex < 4u) {
        return (p.baseNonceHi >> ((3u - nonceIndex) * 8u)) & 0xFFu;
      }
      return (p.baseNonceLo >> ((7u - nonceIndex) * 8u)) & 0xFFu;
    }
  }

  let totalLength = dataLength + select(0u, 8u, p.mode == 1u);
  if (index == totalLength) {
    return 0x80u;
  }

  let paddedLength = ((totalLength + 8u) / 64u + 1u) * 64u;
  if (index >= paddedLength - 8u) {
    let lengthIndex = index - (paddedLength - 8u);
    let shift = (7u - lengthIndex) * 8u;
    if (shift < 32u) {
      return ((totalLength * 8u) >> shift) & 0xFFu;
    }
    return 0u;
  }

  return 0u;
}

fn countLeadingZeroBits(digest: array<u32, 8>) -> u32 {
  for (var i = 0u; i < 8u; i = i + 1u) {
    let word = digest[i];
    if (word != 0u) {
      var bits = 0u;
      var mask = 0x80000000u;
      while ((word & mask) == 0u) {
        bits = bits + 1u;
        mask = mask >> 1u;
      }
      return i * 32u + bits;
    }
  }
  return 256u;
}

fn sha256Digest(p: Params) -> array<u32, 8> {
  let totalLength = p.dataLength + select(0u, 8u, p.mode == 1u);
  let paddedLength = ((totalLength + 8u) / 64u + 1u) * 64u;
  let blockCount = paddedLength / 64u;

  var h0 = 0x6a09e667u;
  var h1 = 0xbb67ae85u;
  var h2 = 0x3c6ef372u;
  var h3 = 0xa54ff53au;
  var h4 = 0x510e527fu;
  var h5 = 0x9b05688cu;
  var h6 = 0x1f83d9abu;
  var h7 = 0x5be0cd19u;

  var w = array<u32, 64>();

  for (var block = 0u; block < blockCount; block = block + 1u) {
    let base = block * 64u;
    for (var i = 0u; i < 16u; i = i + 1u) {
      let j = base + i * 4u;
      w[i] = (readByte(j, p) << 24u) |
             (readByte(j + 1u, p) << 16u) |
             (readByte(j + 2u, p) << 8u) |
             readByte(j + 3u, p);
    }

    for (var i = 16u; i < 64u; i = i + 1u) {
      let s0 = rotr(w[i - 15u], 7u) ^ rotr(w[i - 15u], 18u) ^ (w[i - 15u] >> 3u);
      let s1 = rotr(w[i - 2u], 17u) ^ rotr(w[i - 2u], 19u) ^ (w[i - 2u] >> 10u);
      w[i] = w[i - 16u] + s0 + w[i - 7u] + s1;
    }

    var a = h0;
    var b = h1;
    var c = h2;
    var d = h3;
    var e = h4;
    var f = h5;
    var g = h6;
    var h = h7;

    for (var i = 0u; i < 64u; i = i + 1u) {
      let bigSigma1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
      let choose = (e & f) ^ (~e & g);
      let temp1 = h + bigSigma1 + choose + K[i] + w[i];
      let bigSigma0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
      let majority = (a & b) ^ (a & c) ^ (b & c);
      let temp2 = bigSigma0 + majority;

      h = g;
      g = f;
      f = e;
      e = d + temp1;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2;
    }

    h0 = h0 + a;
    h1 = h1 + b;
    h2 = h2 + c;
    h3 = h3 + d;
    h4 = h4 + e;
    h5 = h5 + f;
    h6 = h6 + g;
    h7 = h7 + h;
  }

  return array<u32, 8>(h0, h1, h2, h3, h4, h5, h6, h7);
}

@compute @workgroup_size(256)
fn solve(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.dispatchSize) {
    return;
  }

  var q = params;
  let lo = params.baseNonceLo + gid.x;
  q.baseNonceLo = lo;
  if (lo < params.baseNonceLo) {
    q.baseNonceHi = params.baseNonceHi + 1u;
  }

  let digest = sha256Digest(q);
  if (countLeadingZeroBits(digest) >= params.difficulty) {
    var claimed = false;
    while (!claimed) {
      let exchange = atomicCompareExchangeWeak(&solveResult.flag, 0u, 1u);
      if (exchange.exchanged) {
        claimed = true;
      } else if (exchange.old_value != 0u) {
        return;
      }
    }
    atomicStore(&solveResult.nonceHi, q.baseNonceHi);
    atomicStore(&solveResult.nonceLo, q.baseNonceLo);
  }
}

@compute @workgroup_size(1)
fn hash(@builtin(global_invocation_id) gid: vec3<u32>) {
  let digest = sha256Digest(params);
  for (var i = 0u; i < 8u; i = i + 1u) {
    digestResult[i] = digest[i];
  }
}
`;

export class WebGpuUnavailableError extends Error {
  constructor(message = 'WebGPU is not available in this browser') {
    super(message);
    this.name = 'WebGpuUnavailableError';
  }
}

export class WebGpuDeviceLostError extends Error {
  constructor(message = 'The WebGPU device was lost during the operation') {
    super(message);
    this.name = 'WebGpuDeviceLostError';
  }
}

export class WebGpuResultError extends Error {
  constructor(message = 'WebGPU returned an invalid result') {
    super(message);
    this.name = 'WebGpuResultError';
  }
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

/** Validate a leading-zero-bit difficulty value. */
function assertDifficulty(difficulty) {
  if (typeof difficulty !== 'number' || !Number.isInteger(difficulty)) {
    throw new TypeError('difficulty must be an integer between 0 and 256');
  }
  if (difficulty < 0 || difficulty > 256) {
    throw new RangeError('difficulty must be between 0 and 256');
  }
}

/** Validate a nonce value and throw when it is not usable. */
function assertNonce(nonce) {
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
    throw new TypeError('nonce must be a non-negative safe integer');
  }
}

/** Validate a positive safe-integer solver option. */
function assertPositiveSafeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertSignal(signal) {
  if (signal === undefined || signal === null) {
    return;
  }
  if (
    typeof signal !== 'object' ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function' ||
    typeof signal.removeEventListener !== 'function'
  ) {
    throw new TypeError('signal must be an AbortSignal or undefined');
  }
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

function createAbortPromise(signal) {
  if (signal === undefined || signal === null) {
    return null;
  }
  if (signal.aborted) {
    return {
      promise: Promise.reject(createAbortError()),
      cleanup: () => {}
    };
  }
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
  });
  return { promise, cleanup };
}

function bytesToWords(bytes) {
  const words = new Uint32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    words[i] = bytes[i];
  }
  return words;
}

function splitNonce(nonce) {
  const big = BigInt(nonce);
  return {
    lo: Number(big & 0xffffffffn),
    hi: Number((big >> 32n) & 0xffffffffn)
  };
}

function encodeParams({
  dataLength,
  baseNonceLo,
  baseNonceHi,
  difficulty,
  dispatchSize,
  mode
}) {
  const words = new Uint32Array(PARAMS_WORDS);
  words[0] = dataLength;
  words[1] = baseNonceLo;
  words[2] = baseNonceHi;
  words[3] = difficulty;
  words[4] = dispatchSize;
  words[5] = mode;
  words[6] = 0;
  words[7] = 0;
  return words;
}

function getGpu() {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.gpu !== undefined &&
      navigator.gpu !== null &&
      typeof navigator.gpu.requestAdapter === 'function'
    ) {
      return navigator.gpu;
    }
  } catch {
    // Fall through to the unavailable error below.
  }
  return null;
}

async function acquireDevice(gpu, signal) {
  throwIfAborted(signal);

  let adapter;
  try {
    adapter = await gpu.requestAdapter();
  } catch (error) {
    throwIfAborted(signal);
    throw new WebGpuUnavailableError('Unable to request a WebGPU adapter');
  }
  throwIfAborted(signal);
  if (adapter === undefined || adapter === null) {
    throw new WebGpuUnavailableError('No WebGPU adapter is available');
  }

  let device;
  try {
    device = await adapter.requestDevice();
  } catch (error) {
    throwIfAborted(signal);
    throw new WebGpuUnavailableError('Unable to request a WebGPU device');
  }
  if (device === undefined || device === null) {
    throw new WebGpuUnavailableError('No WebGPU device is available');
  }
  try {
    throwIfAborted(signal);
  } catch (error) {
    destroyDevice(device);
    throw error;
  }
  return device;
}

function destroyDevice(device) {
  if (device === undefined || device === null) {
    return;
  }
  try {
    device.destroy();
  } catch {
    // The device was already lost or destroyed.
  }
}

function createDeviceLostTracker(device) {
  let released = false;
  let lost = false;
  const deviceLost =
    device.lost !== undefined && typeof device.lost.then === 'function'
      ? device.lost
      : new Promise(() => {});
  const lostPromise = Promise.resolve(deviceLost).then(() => {
    if (!released) {
      lost = true;
    }
  });

  return {
    lostPromise,
    isLost: () => lost,
    markReleased: () => {
      released = true;
    }
  };
}

async function waitForGpu(promise, signal, tracker) {
  const contenders = [Promise.resolve(promise)];
  const abort = createAbortPromise(signal);
  if (abort !== null) {
    contenders.push(abort.promise);
  }
  const deviceLossContender = tracker.lostPromise.then(() => {
    throw new WebGpuDeviceLostError();
  });
  // If the GPU operation settles first, Promise.race stops observing this
  // contender. `device.destroy()` later resolves `device.lost`, which makes
  // this promise reject after the race is already settled. Attach a no-op
  // rejection handler so that late rejection is considered handled.
  deviceLossContender.catch(() => {});
  contenders.push(deviceLossContender);

  try {
    await Promise.race(contenders);
  } catch (error) {
    if (tracker.isLost()) {
      throw new WebGpuDeviceLostError();
    }
    throw error;
  } finally {
    if (abort !== null) {
      try {
        abort.cleanup();
      } catch {
        // Cleanup must not mask the GPU result or the original wait error.
      }
    }
  }

  throwIfAborted(signal);
  if (tracker.isLost()) {
    throw new WebGpuDeviceLostError();
  }
}

async function mapReadBuffer(device, buffer, wordCount, signal, tracker) {
  await waitForGpu(buffer.mapAsync(MAP_MODE_READ), signal, tracker);

  const mapped = buffer.getMappedRange(0, wordCount * 4);
  const words = new Uint32Array(wordCount);
  words.set(new Uint32Array(mapped, 0, wordCount));
  buffer.unmap();
  return words;
}

function wordsToHex(words) {
  let hex = '';
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    hex += ((word >>> 24) & 0xff).toString(16).padStart(2, '0');
    hex += ((word >>> 16) & 0xff).toString(16).padStart(2, '0');
    hex += ((word >>> 8) & 0xff).toString(16).padStart(2, '0');
    hex += (word & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

function createBuffer(device, size, usage) {
  return device.createBuffer({ size, usage });
}

function writeDataBuffer(device, buffer, bytes) {
  if (bytes.length === 0) {
    // WebGPU buffer sizes must be positive, and an empty challenge is valid.
    // The shader never reads this padding word because dataLength is zero.
    device.queue.writeBuffer(buffer, 0, new Uint32Array([0]));
    return;
  }
  device.queue.writeBuffer(buffer, 0, bytesToWords(bytes));
}

function createShaderModule(device) {
  return device.createShaderModule({ code: SHA256_CODE });
}

function createStorageReadBindGroupLayout(device, bindings) {
  return device.createBindGroupLayout({
    entries: bindings.map(({ binding, type }) => ({
      binding,
      visibility: SHADER_STAGE_COMPUTE,
      buffer: { type }
    }))
  });
}

function createPipeline(device, module, entryPoint, bindGroupLayout) {
  return device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout]
    }),
    compute: { module, entryPoint }
  });
}

/**
 * Decode a three-word GPU solve-result buffer.
 *
 * @param {Uint32Array} words At least three `u32` values:
 *   `[flag, nonceHi, nonceLo]`. `flag === 0` is the not-found sentinel.
 * @returns {number|null} The winning nonce, or `null` for the not-found
 *   sentinel.
 */
export function decodeSolveResult(words) {
  if (!(words instanceof Uint32Array) || words.length < SOLVE_RESULT_WORDS) {
    throw new TypeError(
      'result must be a Uint32Array with at least 3 elements'
    );
  }
  const flag = words[0];
  if (flag === 0) {
    return null;
  }
  if (flag !== 1) {
    throw new TypeError(`invalid GPU solve-result flag: ${flag}`);
  }
  const nonce = BigInt(words[1]) * 0x100000000n + BigInt(words[2]);
  if (nonce > BigInt(MAX_NONCE)) {
    throw new RangeError('GPU solve-result nonce exceeds Number.MAX_SAFE_INTEGER');
  }
  return Number(nonce);
}

/**
 * Compute the SHA-256 hex digest of `data` on the GPU.
 *
 * This is primarily useful for WebGPU SHA-256 parity checks and for
 * applications that want a single GPU hash. The proof-of-work solver itself
 * never copies per-attempt digests back to JavaScript.
 *
 * @param {string|Uint8Array|ArrayBuffer} data
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] Cancellation signal.
 * @returns {Promise<string>} Lowercase hexadecimal SHA-256 digest.
 */
export async function sha256WebGpu(data, options = {}) {
  const bytes = toChallengeBytes(data);
  if (bytes.length > MAX_CHALLENGE_BYTES) {
    throw new RangeError(
      `challenge must contain at most ${MAX_CHALLENGE_BYTES} bytes`
    );
  }

  const { signal = undefined } = options ?? {};
  assertSignal(signal);
  throwIfAborted(signal);

  const gpu = getGpu();
  if (gpu === null) {
    throw new WebGpuUnavailableError();
  }
  const device = await acquireDevice(gpu, signal);
  const tracker = createDeviceLostTracker(device);

  try {
    const dataBuffer = createBuffer(
      device,
      Math.max(4, bytes.length * 4),
      BUFFER_STORAGE | BUFFER_COPY_DST
    );
    writeDataBuffer(device, dataBuffer, bytes);

    const paramsBuffer = createBuffer(
      device,
      PARAMS_BYTES,
      BUFFER_UNIFORM | BUFFER_COPY_DST
    );
    device.queue.writeBuffer(
      paramsBuffer,
      0,
      encodeParams({
        dataLength: bytes.length,
        baseNonceLo: 0,
        baseNonceHi: 0,
        difficulty: 0,
        dispatchSize: 1,
        mode: MODE_HASH
      })
    );

    const digestBuffer = createBuffer(
      device,
      DIGEST_BYTES,
      BUFFER_STORAGE | BUFFER_COPY_SRC | BUFFER_COPY_DST
    );
    device.queue.writeBuffer(digestBuffer, 0, new Uint32Array(DIGEST_WORDS));

    const readbackBuffer = createBuffer(
      device,
      DIGEST_BYTES,
      BUFFER_COPY_DST | BUFFER_MAP_READ
    );

    const module = createShaderModule(device);
    const bindGroupLayout = createStorageReadBindGroupLayout(device, [
      { binding: 0, type: 'read-only-storage' },
      { binding: 1, type: 'uniform' },
      { binding: 3, type: 'storage' }
    ]);
    const pipeline = createPipeline(device, module, 'hash', bindGroupLayout);
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: dataBuffer } },
        { binding: 1, resource: { buffer: paramsBuffer } },
        { binding: 3, resource: { buffer: digestBuffer } }
      ]
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(digestBuffer, 0, readbackBuffer, 0, DIGEST_BYTES);
    device.queue.submit([encoder.finish()]);

    await waitForGpu(device.queue.onSubmittedWorkDone(), signal, tracker);
    const words = await mapReadBuffer(
      device,
      readbackBuffer,
      DIGEST_WORDS,
      signal,
      tracker
    );
    return wordsToHex(words);
  } finally {
    tracker.markReleased();
    try {
      device.destroy();
    } catch {
      // The device was already lost or destroyed.
    }
  }
}

/**
 * Asynchronously solve for a valid nonce using a WebGPU compute shader.
 *
 * Each compute dispatch searches a bounded nonce range in parallel. The only
 * per-dispatch GPU data copied back to JavaScript is a three-word result
 * buffer: a not-found sentinel or a single winning nonce. Because a parallel
 * dispatch may report a higher winner before a lower one, the prefix before a
 * returned winner is re-scanned with the JavaScript solver so the resolved
 * nonce is the smallest valid nonce in the searched range. The returned nonce
 * is verified with the browser SHA-256 implementation before resolving.
 *
 * @param {string|Uint8Array|ArrayBuffer} challenge
 * @param {number} difficulty Integer from 0 to 256 inclusive.
 * @param {object} [options]
 * @param {number} [options.start=0] Non-negative safe integer to start from.
 * @param {number} [options.maxAttempts=1000000] Maximum nonce values to try.
 * @param {number} [options.batchSize=262144] Nonces searched per dispatch.
 * @param {AbortSignal} [options.signal] Cancellation signal.
 * @returns {Promise<number>} The smallest valid nonce found at or after
 *   `start`, or a rejected promise when no such nonce exists.
 */
export async function solveWebGpu(challenge, difficulty, options = {}) {
  assertDifficulty(difficulty);
  const challengeBytes = toChallengeBytes(challenge);
  if (challengeBytes.length > MAX_CHALLENGE_BYTES) {
    throw new RangeError(
      `challenge must contain at most ${MAX_CHALLENGE_BYTES} bytes`
    );
  }

  const {
    start = 0,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    batchSize = DEFAULT_BATCH_SIZE,
    signal = undefined
  } = options ?? {};

  assertNonce(start);
  assertPositiveSafeInteger(maxAttempts, 'maxAttempts');
  assertPositiveSafeInteger(batchSize, 'batchSize');
  assertSignal(signal);
  throwIfAborted(signal);

  const gpu = getGpu();
  if (gpu === null) {
    throw new WebGpuUnavailableError();
  }
  const device = await acquireDevice(gpu, signal);
  const tracker = createDeviceLostTracker(device);

  try {
    const maxWorkgroups =
      device.limits !== undefined &&
      device.limits !== null &&
      Number.isFinite(device.limits.maxComputeWorkgroupsPerDimension)
        ? device.limits.maxComputeWorkgroupsPerDimension
        : 0;
    if (maxWorkgroups < 1) {
      throw new WebGpuUnavailableError(
        'WebGPU device does not report compute workgroup limits'
      );
    }
    const maxNoncesPerDispatch = maxWorkgroups * WORKGROUP_SIZE;
    if (batchSize > maxNoncesPerDispatch) {
      throw new RangeError(
        `batchSize ${batchSize} exceeds the device dispatch limit of ` +
          `${maxNoncesPerDispatch} nonces per dispatch`
      );
    }

    const dataBuffer = createBuffer(
      device,
      Math.max(4, challengeBytes.length * 4),
      BUFFER_STORAGE | BUFFER_COPY_DST
    );
    writeDataBuffer(device, dataBuffer, challengeBytes);

    const paramsBuffer = createBuffer(
      device,
      PARAMS_BYTES,
      BUFFER_UNIFORM | BUFFER_COPY_DST
    );

    // The only per-dispatch GPU result is `resultBuffer` (three words: a
    // winning nonce or the not-found sentinel). WebGPU storage buffers cannot
    // be mapped directly, so `readbackBuffer` is a fixed staging buffer used
    // only to copy that one result to JavaScript.
    const resultBuffer = createBuffer(
      device,
      SOLVE_RESULT_BYTES,
      BUFFER_STORAGE | BUFFER_COPY_SRC | BUFFER_COPY_DST
    );
    device.queue.writeBuffer(resultBuffer, 0, SOLVE_RESULT_NOT_FOUND);

    const readbackBuffer = createBuffer(
      device,
      SOLVE_RESULT_BYTES,
      BUFFER_COPY_DST | BUFFER_MAP_READ
    );

    const module = createShaderModule(device);
    const bindGroupLayout = createStorageReadBindGroupLayout(device, [
      { binding: 0, type: 'read-only-storage' },
      { binding: 1, type: 'uniform' },
      { binding: 2, type: 'storage' }
    ]);
    const pipeline = createPipeline(device, module, 'solve', bindGroupLayout);
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: dataBuffer } },
        { binding: 1, resource: { buffer: paramsBuffer } },
        { binding: 2, resource: { buffer: resultBuffer } }
      ]
    });

    let nonce = start;
    let attempts = 0;

    while (attempts < maxAttempts && nonce <= MAX_NONCE) {
      throwIfAborted(signal);

      const remainingAttempts = maxAttempts - attempts;
      const remainingNonces = MAX_NONCE - nonce + 1;
      const batch = Math.min(batchSize, remainingAttempts, remainingNonces);

      const { lo: baseNonceLo, hi: baseNonceHi } = splitNonce(nonce);
      device.queue.writeBuffer(
        resultBuffer,
        0,
        SOLVE_RESULT_NOT_FOUND
      );
      device.queue.writeBuffer(
        paramsBuffer,
        0,
        encodeParams({
          dataLength: challengeBytes.length,
          baseNonceLo,
          baseNonceHi,
          difficulty,
          dispatchSize: batch,
          mode: MODE_SOLVE
        })
      );

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(batch / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(
        resultBuffer,
        0,
        readbackBuffer,
        0,
        SOLVE_RESULT_BYTES
      );
      device.queue.submit([encoder.finish()]);

      await waitForGpu(device.queue.onSubmittedWorkDone(), signal, tracker);
      const words = await mapReadBuffer(
        device,
        readbackBuffer,
        SOLVE_RESULT_WORDS,
        signal,
        tracker
      );
      const resultNonce = decodeSolveResult(words);

      if (resultNonce !== null) {
        if (
          !Number.isSafeInteger(resultNonce) ||
          resultNonce < nonce ||
          resultNonce - nonce >= batch
        ) {
          throw new WebGpuResultError(
            'GPU returned a nonce outside the searched nonce range'
          );
        }
        if (!meetsDifficulty(hashChallenge(challengeBytes, resultNonce), difficulty)) {
          throw new WebGpuResultError(
            'GPU returned a nonce that does not satisfy the challenge difficulty'
          );
        }

        // A compute dispatch evaluates its nonce range in parallel, so the
        // GPU's "first winner" may be a higher nonce even when a lower nonce
        // in the same dispatch also satisfies the difficulty. Re-scan the
        // prefix of this dispatch with the JavaScript solver, which returns
        // the lowest valid nonce and remains abortable while it works.
        const prefixLength = resultNonce - nonce;
        if (prefixLength > 0) {
          try {
            return await browserSolve(challengeBytes, difficulty, {
              start: nonce,
              maxAttempts: prefixLength,
              signal
            });
          } catch (error) {
            if (error !== undefined && error !== null && error.name === 'AbortError') {
              throw error;
            }
            if (
              !(error instanceof Error) ||
              error.message !==
                `no valid nonce found within ${prefixLength} attempt(s) for difficulty ${difficulty}`
            ) {
              throw error;
            }
          }
        }
        return resultNonce;
      }

      nonce += batch;
      attempts += batch;
    }

    throw new Error(
      `no valid nonce found within ${maxAttempts} attempt(s) for difficulty ${difficulty}`
    );
  } finally {
    tracker.markReleased();
    try {
      device.destroy();
    } catch {
      // The device was already lost or destroyed.
    }
  }
}
