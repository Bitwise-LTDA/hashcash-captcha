import test from 'node:test';
import assert from 'node:assert/strict';

import { verify as serverVerify } from '../src/pow.js';
import {
  hashChallenge as browserHashChallenge,
  meetsDifficulty as browserMeetsDifficulty,
  solve as browserSolve
} from '../src/pow.browser.js';
import {
  SHA256_CODE,
  decodeSolveResult,
  sha256WebGpu,
  solveWebGpu,
  WebGpuDeviceLostError,
  WebGpuResultError,
  WebGpuUnavailableError
} from '../src/pow.webgpu.js';

const SOLVE_RESULT_BYTES = 12;

function splitNonce(nonce) {
  const big = BigInt(nonce);
  return {
    lo: Number(big & 0xffffffffn),
    hi: Number((big >> 32n) & 0xffffffffn)
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
  globalThis.navigator = globalThis.navigator ?? {};
  globalThis.navigator.gpu = fakeGpu;
  return () => {
    delete globalThis.navigator.gpu;
  };
}

function createInstrumentedSignal(controller) {
  const signal = controller.signal;
  let active = 0;
  const counts = {
    additions: 0,
    removals: 0,
    maxActive: 0
  };
  const instrumented = {
    get aborted() {
      return signal.aborted;
    },
    addEventListener(type, listener, options) {
      if (type === 'abort') {
        counts.additions += 1;
        active += 1;
        counts.maxActive = Math.max(counts.maxActive, active);
      }
      return signal.addEventListener(type, listener, options);
    },
    removeEventListener(type, listener, options) {
      if (type === 'abort') {
        counts.removals += 1;
        active -= 1;
      }
      return signal.removeEventListener(type, listener, options);
    }
  };
  return { signal: instrumented, counts, getActive: () => active };
}

test('WGSL countLeadingZeroBits advances by 32 bits per zero digest word', () => {
  assert.match(
    SHA256_CODE,
    /return i \* 32u \+ bits;/,
    'WGSL leading-zero count must use a 32-bit word stride'
  );
  assert.doesNotMatch(
    SHA256_CODE,
    /return i \* 8u \+ bits;/,
    'WGSL leading-zero count must not use an 8-bit word stride'
  );
});

test('WGSL solve winner gate uses the compare-exchange exchanged result', () => {
  assert.match(
    SHA256_CODE,
    /exchange\.exchanged/,
    'WGSL winner gate must use atomicCompareExchangeWeak exchanged result'
  );
  assert.doesNotMatch(
    SHA256_CODE,
    /if \(exchange\.old_value == 0u\)/,
    'WGSL winner gate must not ignore the exchanged result'
  );
});

test('decodeSolveResult decodes the not-found sentinel and winning nonces', () => {
  assert.equal(
    decodeSolveResult(new Uint32Array([0, 0xffffffff, 0xffffffff])),
    null
  );
  assert.equal(decodeSolveResult(new Uint32Array([1, 0, 0])), 0);
  assert.equal(decodeSolveResult(new Uint32Array([1, 0, 42])), 42);
  assert.equal(
    decodeSolveResult(new Uint32Array([1, 0x1fffff, 0xffffffff])),
    Number.MAX_SAFE_INTEGER
  );
  assert.throws(
    () => decodeSolveResult(new Uint32Array([2, 0, 0])),
    TypeError
  );
  assert.throws(
    () => decodeSolveResult(new Uint32Array([1, 0x200000, 0])),
    RangeError
  );
  assert.throws(() => decodeSolveResult(new Uint32Array(2)), TypeError);
});

test('solveWebGpu validates difficulty and nonce-range options', async () => {
  await assert.rejects(solveWebGpu('abc', -1), RangeError);
  await assert.rejects(solveWebGpu('abc', 1.5), TypeError);
  await assert.rejects(solveWebGpu('abc', 257), RangeError);

  await assert.rejects(solveWebGpu('abc', 0, { start: -1 }), TypeError);
  await assert.rejects(solveWebGpu('abc', 0, { start: 1.5 }), TypeError);
  await assert.rejects(
    solveWebGpu('abc', 0, { maxAttempts: 0 }),
    TypeError
  );
  await assert.rejects(
    solveWebGpu('abc', 0, { maxAttempts: Number.MAX_SAFE_INTEGER + 1 }),
    TypeError
  );
  await assert.rejects(solveWebGpu('abc', 0, { batchSize: 0 }), TypeError);
  await assert.rejects(solveWebGpu('abc', 0, { batchSize: 1.5 }), TypeError);
  await assert.rejects(solveWebGpu('abc', 0, { signal: {} }), TypeError);
});

test('solveWebGpu rejects incomplete signal-like objects before GPU acquisition', async () => {
  let adapterRequests = 0;
  const fakeGpu = {
    async requestAdapter() {
      adapterRequests += 1;
      throw new Error('requestAdapter must not be called for invalid signals');
    }
  };
  const restore = installFakeGpu(fakeGpu);

  try {
    await assert.rejects(
      solveWebGpu('abc', 0, { signal: { aborted: false } }),
      TypeError
    );
    await assert.rejects(
      solveWebGpu('abc', 0, {
        signal: { aborted: false, addEventListener() {} }
      }),
      TypeError
    );
    await assert.rejects(
      solveWebGpu('abc', 0, {
        signal: { aborted: false, removeEventListener() {} }
      }),
      TypeError
    );
    assert.equal(adapterRequests, 0);
  } finally {
    restore();
  }
});

test('solveWebGpu accepts AbortController.signal, undefined, and null signals', async () => {
  let adapterRequests = 0;
  const fakeGpu = {
    async requestAdapter() {
      adapterRequests += 1;
      throw new Error('expected adapter failure');
    }
  };
  const restore = installFakeGpu(fakeGpu);
  const controller = new AbortController();

  try {
    await assert.rejects(
      solveWebGpu('abc', 0, { signal: controller.signal }),
      WebGpuUnavailableError
    );
    await assert.rejects(
      solveWebGpu('abc', 0, { signal: undefined }),
      WebGpuUnavailableError
    );
    await assert.rejects(
      solveWebGpu('abc', 0, { signal: null }),
      WebGpuUnavailableError
    );
    assert.equal(adapterRequests, 3);
  } finally {
    restore();
  }
});

test('solveWebGpu and sha256WebGpu throw WebGpuUnavailableError without WebGPU', async () => {
  const previousNavigator = globalThis.navigator;
  delete globalThis.navigator;

  try {
    await assert.rejects(
      solveWebGpu('abc', 8),
      (error) =>
        error instanceof WebGpuUnavailableError &&
        error.name === 'WebGpuUnavailableError'
    );
    await assert.rejects(
      sha256WebGpu('abc'),
      (error) =>
        error instanceof WebGpuUnavailableError &&
        error.name === 'WebGpuUnavailableError'
    );
  } finally {
    if (previousNavigator !== undefined) {
      globalThis.navigator = previousNavigator;
    }
  }
});

test('solveWebGpu rejects with AbortError when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    solveWebGpu('abc', 8, { signal: controller.signal }),
    (error) => error && error.name === 'AbortError'
  );
});

test('solveWebGpu destroys a device acquired during a cancellation race', async () => {
  const controller = new AbortController();
  const device = new FakeDevice();
  const fakeGpu = {
    device,
    async requestAdapter() {
      return {
        async requestDevice() {
          controller.abort();
          return device;
        }
      };
    }
  };
  const restore = installFakeGpu(fakeGpu);

  try {
    await assert.rejects(
      solveWebGpu('abc', 8, { signal: controller.signal }),
      (error) => error && error.name === 'AbortError'
    );
    assert.equal(device.destroyed, true);
  } finally {
    restore();
  }
});

test('solveWebGpu rejects with AbortError when cancelled during a dispatch', async () => {
  const restore = installFakeGpu(createFakeGpu({ workDoneDelayMs: 30 }));
  const controller = new AbortController();

  try {
    const solving = solveWebGpu('abc', 256, {
      maxAttempts: 10,
      batchSize: 4,
      signal: controller.signal
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await assert.rejects(
      solving,
      (error) => error && error.name === 'AbortError'
    );
  } finally {
    restore();
  }
});

test('solveWebGpu removes abort listeners after each GPU wait in a multi-dispatch solve', async () => {
  const restore = installFakeGpu(createFakeGpu());
  const controller = new AbortController();
  const { signal, counts, getActive } = createInstrumentedSignal(controller);

  try {
    await assert.rejects(
      solveWebGpu('abc', 256, {
        maxAttempts: 9,
        batchSize: 3,
        signal
      }),
      /no valid nonce found within 9 attempt\(s\) for difficulty 256/
    );

    assert.ok(counts.additions > 0, 'expected temporary abort listeners to be added');
    assert.equal(counts.additions, counts.removals);
    assert.equal(getActive(), 0);
    assert.equal(counts.maxActive, 1);
  } finally {
    restore();
  }
});

test('solveWebGpu removes abort listeners after a successful solve', async () => {
  const challenge = 'hashcash-captcha-webgpu';
  const difficulty = 10;
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
  const controller = new AbortController();
  const { signal, counts, getActive } = createInstrumentedSignal(controller);

  try {
    const nonce = await solveWebGpu(challenge, difficulty, {
      start: validNonce,
      maxAttempts: 1,
      batchSize: 1,
      signal
    });

    assert.equal(nonce, validNonce);
    assert.ok(counts.additions > 0, 'expected temporary abort listeners to be added');
    assert.equal(counts.additions, counts.removals);
    assert.equal(getActive(), 0);
  } finally {
    restore();
  }
});

test('solveWebGpu removes abort listeners after abort rejection', async () => {
  const restore = installFakeGpu(createFakeGpu({ workDoneDelayMs: 30 }));
  const controller = new AbortController();
  const { signal, counts, getActive } = createInstrumentedSignal(controller);

  try {
    const solving = solveWebGpu('abc', 256, {
      maxAttempts: 10,
      batchSize: 4,
      signal
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await assert.rejects(
      solving,
      (error) => error && error.name === 'AbortError'
    );
    assert.ok(counts.additions > 0, 'expected temporary abort listeners to be added');
    assert.equal(counts.additions, counts.removals);
    assert.equal(getActive(), 0);
  } finally {
    restore();
  }
});

test('solveWebGpu removes abort listeners after device loss', async () => {
  let resolveLost;
  const lost = new Promise((resolve) => {
    resolveLost = resolve;
  });
  const restore = installFakeGpu(
    createFakeGpu({ workDoneDelayMs: 30, lost })
  );
  const controller = new AbortController();
  const { signal, counts, getActive } = createInstrumentedSignal(controller);

  try {
    const solving = solveWebGpu('abc', 256, {
      maxAttempts: 10,
      batchSize: 4,
      signal
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    resolveLost();

    await assert.rejects(
      solving,
      (error) =>
        error instanceof WebGpuDeviceLostError &&
        error.name === 'WebGpuDeviceLostError'
    );
    assert.ok(counts.additions > 0, 'expected temporary abort listeners to be added');
    assert.equal(counts.additions, counts.removals);
    assert.equal(getActive(), 0);
  } finally {
    restore();
  }
});

test('solveWebGpu detects nonce-range exhaustion', async () => {
  const restore = installFakeGpu(createFakeGpu());

  try {
    await assert.rejects(
      solveWebGpu('abc', 256, { maxAttempts: 3, batchSize: 1 }),
      /no valid nonce found within 3 attempt\(s\) for difficulty 256/
    );
  } finally {
    restore();
  }
});

test('solveWebGpu rejects when the device is lost during a dispatch', async () => {
  let resolveLost;
  const lost = new Promise((resolve) => {
    resolveLost = resolve;
  });
  const restore = installFakeGpu(
    createFakeGpu({ workDoneDelayMs: 30, lost })
  );

  try {
    const solving = solveWebGpu('abc', 256, { maxAttempts: 10, batchSize: 4 });

    await new Promise((resolve) => setTimeout(resolve, 5));
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

test('solveWebGpu does not emit an unhandled rejection after device.destroy resolves device.lost', async () => {
  const challenge = 'hashcash-captcha-webgpu';
  const difficulty = 10;
  const validNonce = await browserSolve(challenge, difficulty);
  const { lo, hi } = splitNonce(validNonce);

  let resolveLost;
  const fakeGpu = createFakeGpu();
  const device = fakeGpu.device;
  device.lost = new Promise((resolve) => {
    resolveLost = resolve;
  });
  const originalDestroy = device.destroy.bind(device);
  device.destroy = () => {
    originalDestroy();
    resolveLost();
  };

  fakeGpu.device.queue.beforeSubmit = (commandBuffer) => {
    fakeGpu.device.queue.writeBuffer(
      commandBuffer.copies[0].source,
      0,
      new Uint32Array([1, hi, lo])
    );
  };

  const restore = installFakeGpu(fakeGpu);
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const nonce = await solveWebGpu(challenge, difficulty, {
      start: validNonce,
      maxAttempts: 1,
      batchSize: 1
    });

    assert.equal(nonce, validNonce);

    // Flush microtasks and timers so a late device-loss contender rejection
    // would be reported to the temporary unhandledRejection listener.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection);
    restore();
  }
});

test('solveWebGpu verifies a returned nonce with the browser SHA-256 implementation', async () => {
  const challenge = 'hashcash-captcha-webgpu';
  const difficulty = 10;
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
    const nonce = await solveWebGpu(challenge, difficulty, {
      start: validNonce,
      maxAttempts: 1,
      batchSize: 1
    });

    assert.equal(nonce, validNonce);
    assert.equal(serverVerify(challenge, nonce, difficulty), true);
    assert.equal(
      browserMeetsDifficulty(browserHashChallenge(challenge, nonce), difficulty),
      true
    );
  } finally {
    restore();
  }
});

test('solveWebGpu returns the lowest valid nonce when a dispatch has multiple winners', async () => {
  const challenge = 'hashcash-captcha-webgpu';
  const difficulty = 10;
  const lowest = await browserSolve(challenge, difficulty);
  const higher = await browserSolve(challenge, difficulty, {
    start: lowest + 1
  });
  assert.ok(higher > lowest);

  const batchSize = higher - lowest + 1;
  const { lo, hi } = splitNonce(higher);

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
    const nonce = await solveWebGpu(challenge, difficulty, {
      start: lowest,
      maxAttempts: batchSize,
      batchSize
    });

    assert.equal(nonce, lowest);
    assert.equal(serverVerify(challenge, nonce, difficulty), true);
    assert.equal(
      browserMeetsDifficulty(browserHashChallenge(challenge, nonce), difficulty),
      true
    );
  } finally {
    restore();
  }
});

test('solveWebGpu rejects an invalid GPU result that fails CPU verification', async () => {
  const challenge = 'hashcash-captcha-webgpu';
  const difficulty = 10;
  const validNonce = await browserSolve(challenge, difficulty);

  let invalidNonce = validNonce + 1;
  while (
    browserMeetsDifficulty(
      browserHashChallenge(challenge, invalidNonce),
      difficulty
    )
  ) {
    invalidNonce += 1;
  }
  const { lo, hi } = splitNonce(invalidNonce);

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
      solveWebGpu(challenge, difficulty, {
        start: invalidNonce,
        maxAttempts: 1,
        batchSize: 1
      }),
      (error) =>
        error instanceof WebGpuResultError &&
        /does not satisfy the challenge difficulty/.test(error.message)
    );
  } finally {
    restore();
  }
});

test('solveWebGpu rejects a GPU result outside the searched nonce range', async () => {
  const challenge = 'hashcash-captcha-webgpu';
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
      solveWebGpu(challenge, difficulty, {
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
