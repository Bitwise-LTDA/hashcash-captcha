import test from 'node:test';
import assert from 'node:assert/strict';

import { verify as serverVerify } from '../src/pow.js';
import { solve as browserSolve } from '../src/pow.browser.js';
import {
  WebGpuDeviceLostError,
  WebGpuResultError,
  WebGpuUnavailableError
} from '../src/pow.webgpu.js';
import { hasWebGpu, solveAuto } from '../src/client.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function disableWebGpu() {
  const previousNavigator = globalThis.navigator;
  globalThis.navigator = {};
  return () => {
    if (previousNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      globalThis.navigator = previousNavigator;
    }
  };
}

class FakeBuffer {
  constructor(size) {
    this.size = size;
    this.bytes = new Uint8Array(size);
    this.mapped = false;
  }

  mapAsync() {
    this.mapped = true;
    return Promise.resolve();
  }

  getMappedRange(offset, size) {
    return this.bytes.buffer.slice(offset, offset + size);
  }

  unmap() {
    this.mapped = false;
  }
}

class FakeCommandEncoder {
  constructor(queue) {
    this.queue = queue;
    this.copies = [];
  }

  beginComputePass() {
    return {
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups() {},
      end() {}
    };
  }

  copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size) {
    this.copies.push({ source, sourceOffset, destination, destinationOffset, size });
  }

  finish() {
    return { copies: this.copies };
  }
}

class FakeQueue {
  constructor(device, options) {
    this.device = device;
    this.workDoneDelayMs = options.workDoneDelayMs ?? 0;
    this.beforeSubmit = null;
  }

  writeBuffer(buffer, offset, data, dataOffset = 0, size = data.byteLength - dataOffset) {
    const bytes = new Uint8Array(
      data.buffer,
      data.byteOffset + dataOffset,
      size
    );
    buffer.bytes.set(bytes, offset);
  }

  submit(commandBuffers) {
    if (this.beforeSubmit !== null) {
      for (const commandBuffer of commandBuffers) {
        this.beforeSubmit(commandBuffer);
      }
    }
    for (const commandBuffer of commandBuffers) {
      for (const copy of commandBuffer.copies) {
        const bytes = copy.source.bytes.slice(
          copy.sourceOffset,
          copy.sourceOffset + copy.size
        );
        copy.destination.bytes.set(bytes, copy.destinationOffset);
      }
    }
  }

  onSubmittedWorkDone() {
    if (this.workDoneDelayMs === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      setTimeout(resolve, this.workDoneDelayMs);
    });
  }
}

class FakeDevice {
  constructor(options = {}) {
    this.limits = { maxComputeWorkgroupsPerDimension: 65535 };
    this.lost =
      options.lost !== undefined
        ? options.lost
        : new Promise(() => {});
    this.queue = new FakeQueue(this, options);
    this.buffers = [];
    this.destroyed = false;
  }

  createShaderModule() {
    return {};
  }

  createBuffer({ size }) {
    const buffer = new FakeBuffer(size);
    this.buffers.push(buffer);
    return buffer;
  }

  createBindGroupLayout() {
    return {};
  }

  createPipelineLayout() {
    return {};
  }

  createComputePipeline() {
    return {};
  }

  createBindGroup() {
    return {};
  }

  createCommandEncoder() {
    return new FakeCommandEncoder(this.queue);
  }

  destroy() {
    this.destroyed = true;
  }
}

function createFakeGpu(options = {}) {
  const device = new FakeDevice(options);
  return {
    device,
    async requestAdapter() {
      return {
        async requestDevice() {
          return device;
        }
      };
    }
  };
}

function installFakeGpu(fakeGpu) {
  const previousNavigator = globalThis.navigator;
  globalThis.navigator = { gpu: fakeGpu };
  return () => {
    if (previousNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      globalThis.navigator = previousNavigator;
    }
  };
}

function splitNonce(nonce) {
  const big = BigInt(nonce);
  return {
    lo: Number(big & 0xffffffffn),
    hi: Number((big >> 32n) & 0xffffffffn)
  };
}

test('hasWebGpu returns true only for a navigator.gpu with callable requestAdapter', () => {
  assert.equal(
    hasWebGpu({
      navigator: { gpu: { requestAdapter() {} } }
    }),
    true
  );
  assert.equal(hasWebGpu({}), false);
  assert.equal(hasWebGpu({ navigator: {} }), false);
  assert.equal(hasWebGpu({ navigator: { gpu: {} } }), false);
  assert.equal(
    hasWebGpu({ navigator: { gpu: { requestAdapter: 'not-a-function' } } }),
    false
  );
  assert.equal(hasWebGpu({ navigator: { gpu: { requestAdapter: null } } }), false);
  assert.equal(hasWebGpu(null), false);
});

test('hasWebGpu returns false when navigator or gpu access throws', () => {
  assert.equal(
    hasWebGpu({
      get navigator() {
        throw new Error('denied');
      }
    }),
    false
  );
  assert.equal(
    hasWebGpu({
      navigator: {
        get gpu() {
          throw new Error('denied');
        }
      }
    }),
    false
  );
  assert.equal(
    hasWebGpu({
      navigator: {
        gpu: {
          get requestAdapter() {
            throw new Error('denied');
          }
        }
      }
    }),
    false
  );
});

test('hasWebGpu uses the supplied global object or globalThis', () => {
  const restore = installFakeGpu(createFakeGpu());
  try {
    assert.equal(hasWebGpu(), true);
  } finally {
    restore();
  }

  const restoreDisabled = disableWebGpu();
  try {
    assert.equal(hasWebGpu(), false);
  } finally {
    restoreDisabled();
  }
});

test('solveAuto falls back to the JavaScript solver and returns a server-verifiable nonce', async () => {
  const restore = disableWebGpu();
  try {
    const challenge = 'hashcash-captcha-client';
    const difficulty = 5; // Non-byte-aligned, low enough for the JS fallback.
    const nonce = await solveAuto(challenge, difficulty);

    assert.equal(Number.isSafeInteger(nonce), true);
    assert.equal(nonce >= 0, true);
    assert.equal(serverVerify(challenge, nonce, difficulty), true);
  } finally {
    restore();
  }
});

test('solveAuto falls back for Uint8Array challenges too', async () => {
  const restore = disableWebGpu();
  try {
    const challenge = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const difficulty = 5;
    const nonce = await solveAuto(challenge, difficulty);

    assert.equal(serverVerify(challenge, nonce, difficulty), true);
  } finally {
    restore();
  }
});

test('solveAuto propagates validation errors and does not fall back for them', async () => {
  const restore = disableWebGpu();
  try {
    await assert.rejects(solveAuto(123, 0), TypeError);
    await assert.rejects(solveAuto('abc', -1), RangeError);
    await assert.rejects(solveAuto('abc', 1.5), TypeError);
    await assert.rejects(solveAuto('abc', 257), RangeError);
    await assert.rejects(solveAuto('abc', 0, { start: -1 }), TypeError);
    await assert.rejects(solveAuto('abc', 0, { start: 1.5 }), TypeError);
    await assert.rejects(solveAuto('abc', 0, { maxAttempts: 0 }), TypeError);
    await assert.rejects(solveAuto('abc', 0, { maxAttempts: 1.5 }), TypeError);
    await assert.rejects(solveAuto('abc', 0, { batchSize: 0 }), TypeError);
    await assert.rejects(solveAuto('abc', 0, { batchSize: 1.5 }), TypeError);
    await assert.rejects(solveAuto('abc', 0, { signal: {} }), TypeError);
  } finally {
    restore();
  }
});

test('solveAuto rejects with AbortError when the signal is already aborted', async () => {
  const restore = disableWebGpu();
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(
      solveAuto('abc', 8, { signal: controller.signal }),
      (error) => error && error.name === 'AbortError'
    );
  } finally {
    restore();
  }
});

test('solveAuto rejects with AbortError when cancelled during the JavaScript fallback', async () => {
  const restore = disableWebGpu();
  const controller = new AbortController();

  try {
    const solving = solveAuto('abc', 256, {
      maxAttempts: 1_000_000,
      batchSize: 100,
      signal: controller.signal
    });

    // Let the fallback start and yield to the event loop before aborting.
    await delay(0);
    controller.abort();

    await assert.rejects(
      solving,
      (error) => error && error.name === 'AbortError'
    );
  } finally {
    restore();
  }
});

test('solveAuto rejects with AbortError when cancelled during the WebGPU attempt', async () => {
  const restore = installFakeGpu(createFakeGpu({ workDoneDelayMs: 30 }));
  const controller = new AbortController();

  try {
    const solving = solveAuto('abc', 256, {
      maxAttempts: 10,
      batchSize: 4,
      signal: controller.signal
    });

    await delay(5);
    controller.abort();

    await assert.rejects(
      solving,
      (error) => error && error.name === 'AbortError'
    );
  } finally {
    restore();
  }
});

test('solveAuto propagates WebGpuDeviceLostError without falling back', async () => {
  let resolveLost;
  const lost = new Promise((resolve) => {
    resolveLost = resolve;
  });
  const restore = installFakeGpu(
    createFakeGpu({ workDoneDelayMs: 30, lost })
  );

  try {
    const solving = solveAuto('abc', 8, { maxAttempts: 10, batchSize: 4 });

    await delay(5);
    resolveLost();

    await assert.rejects(
      solving,
      (error) =>
        error instanceof WebGpuDeviceLostError &&
        error.name === 'WebGpuDeviceLostError'
    );
  } finally {
    restore();
  }
});

test('solveAuto propagates WebGpuResultError without falling back', async () => {
  const challenge = 'hashcash-captcha-client';
  const difficulty = 8;
  const validNonce = await browserSolve(challenge, difficulty);
  const { lo, hi } = splitNonce(validNonce);

  const fakeGpu = createFakeGpu();
  fakeGpu.device.queue.beforeSubmit = (commandBuffer) => {
    fakeGpu.device.queue.writeBuffer(
      commandBuffer.copies[0].source,
      0,
      new Uint32Array([1, hi, lo])
    );
  };
  const restore = installFakeGpu(fakeGpu);

  try {
    await assert.rejects(
      solveAuto(challenge, difficulty, {
        start: validNonce + 10,
        maxAttempts: 1,
        batchSize: 1
      }),
      (error) =>
        error instanceof WebGpuResultError &&
        /outside the searched nonce range/.test(error.message)
    );
  } finally {
    restore();
  }
});

test('solveAuto propagates max-attempt exhaustion without falling back', async () => {
  const restore = installFakeGpu(createFakeGpu());

  try {
    // With this fake GPU every dispatch reports "not found". At difficulty 0
    // the JavaScript fallback would return nonce 0, so a rejection proves the
    // WebGPU attempt's exhaustion propagated instead of triggering fallback.
    await assert.rejects(
      solveAuto('abc', 0, { maxAttempts: 1, batchSize: 1 }),
      /no valid nonce found within 1 attempt\(s\) for difficulty 0/
    );
  } finally {
    restore();
  }
});

test('solveAuto resolves a WebGPU nonce when WebGPU is available', async () => {
  const challenge = 'hashcash-captcha-client';
  const difficulty = 8;
  const validNonce = await browserSolve(challenge, difficulty);
  const { lo, hi } = splitNonce(validNonce);

  const fakeGpu = createFakeGpu();
  fakeGpu.device.queue.beforeSubmit = (commandBuffer) => {
    fakeGpu.device.queue.writeBuffer(
      commandBuffer.copies[0].source,
      0,
      new Uint32Array([1, hi, lo])
    );
  };
  const restore = installFakeGpu(fakeGpu);

  try {
    const nonce = await solveAuto(challenge, difficulty, {
      start: validNonce,
      maxAttempts: 1,
      batchSize: 1
    });

    assert.equal(nonce, validNonce);
    assert.equal(serverVerify(challenge, nonce, difficulty), true);
  } finally {
    restore();
  }
});
