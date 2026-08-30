/**
 * Browser client dispatcher.
 *
 * This module is a browser-compatible ES module with no Node.js imports and no
 * runtime dependencies. It exposes one entry point, `solveAuto`, that first
 * tries the WebGPU solver and transparently falls back to the dependency-free
 * JavaScript solver only when WebGPU is unavailable.
 *
 * Both underlying solvers use the same canonical challenge-plus-8-byte-nonce
 * encoding and accept the same `challenge`, `difficulty`, and `options`
 * contract. `solveAuto` deliberately does not fall back for real solver
 * failures, validation errors, cancellation, or max-attempt exhaustion, so
 * callers can distinguish WebGPU unavailability from an actual failure.
 */

import { solve as solveJavaScript } from './pow.browser.js';
import { solveWebGpu, WebGpuUnavailableError } from './pow.webgpu.js';

/**
 * Test whether a global object exposes a usable WebGPU entry point.
 *
 * @param {object} [globalObject=globalThis] Global-like object to inspect.
 * @returns {boolean} `true` only when `globalObject.navigator.gpu` exists and
 *   `gpu.requestAdapter` is callable. Returns `false` when the navigator or
 *   gpu objects are absent, when `requestAdapter` is not a function, or when
 *   accessing any of those properties throws.
 */
export function hasWebGpu(globalObject = globalThis) {
  try {
    if (globalObject === null || globalObject === undefined) {
      return false;
    }
    const navigator = globalObject.navigator;
    if (navigator === null || navigator === undefined) {
      return false;
    }
    const gpu = navigator.gpu;
    if (gpu === null || gpu === undefined) {
      return false;
    }
    return typeof gpu.requestAdapter === 'function';
  } catch {
    return false;
  }
}

/**
 * Solve a challenge with WebGPU when available, falling back to JavaScript.
 *
 * The WebGPU solver is attempted first with the exact arguments supplied by
 * the caller. If, and only if, that attempt rejects with
 * `WebGpuUnavailableError`, the JavaScript solver from `./pow.browser.js` is
 * invoked with the same arguments. All other rejections — validation errors,
 * `AbortError`, `WebGpuDeviceLostError`, `WebGpuResultError`, and max-attempt
 * exhaustion — propagate unchanged.
 *
 * @param {string|Uint8Array|ArrayBuffer} challenge
 * @param {number} difficulty Integer from 0 to 256 inclusive.
 * @param {object} [options]
 * @param {number} [options.start=0] Non-negative safe integer to start from.
 * @param {number} [options.maxAttempts=1000000] Maximum nonce values to try.
 * @param {number} [options.batchSize] Nonces searched per bounded batch or
 *   GPU dispatch. Defaults follow the selected solver.
 * @param {AbortSignal} [options.signal] Cancellation signal.
 * @returns {Promise<number>} A nonce whose challenge hash meets the difficulty.
 */
export async function solveAuto(challenge, difficulty, options = {}) {
  try {
    return await solveWebGpu(challenge, difficulty, options);
  } catch (error) {
    if (error instanceof WebGpuUnavailableError) {
      return await solveJavaScript(challenge, difficulty, options);
    }
    throw error;
  }
}
