import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ERROR_EVENT,
  SOLVED_EVENT,
  mountCaptcha
} from '../src/widget.js';

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function abortError() {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.type = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    if (child.parentNode !== null) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    if (listeners !== undefined) {
      listeners.delete(listener);
    }
  }

  dispatchEvent(event) {
    const listeners = this.listeners.get(event.type);
    if (listeners !== undefined) {
      for (const listener of [...listeners]) {
        listener.call(this, event);
      }
    }
    if (event.bubbles && this.parentNode !== null && !event.cancelBubble) {
      return this.parentNode.dispatchEvent(event);
    }
    return true;
  }

  click() {
    if (this.disabled) {
      return false;
    }
    return this.dispatchEvent(
      new Event('click', { bubbles: true, composed: true })
    );
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

function createContainer() {
  const doc = new FakeDocument();
  return { doc, container: doc.createElement('div') };
}

function child(root, className) {
  return root.children.find((element) => element.className === className) ?? null;
}

function rootOf(container) {
  assert.equal(container.children.length, 1);
  return container.children[0];
}

test('mountCaptcha renders an idle control with default labels and accessible status', () => {
  const { container } = createContainer();
  const widget = mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 }
  });

  const root = rootOf(container);
  const button = child(root, 'hc-button');
  const cancel = child(root, 'hc-cancel');
  const progress = child(root, 'hc-progress');
  const status = child(root, 'hc-status');
  const style = root.children.find((element) => element.tagName === 'STYLE');

  assert.equal(root.getAttribute('data-state'), 'idle');
  assert.equal(root.getAttribute('aria-busy'), 'false');
  assert.equal(button.textContent, "I'm human");
  assert.equal(cancel.textContent, 'Cancel');
  assert.equal(cancel.hidden, true);
  assert.equal(progress.hidden, true);
  assert.equal(progress.getAttribute('aria-hidden'), 'true');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, "I'm human");
  assert.equal(button.getAttribute('aria-describedby'), status.getAttribute('id'));
  assert.equal(style === undefined, false);
  assert.match(style.textContent, /prefers-reduced-motion/);

  widget.destroy();
});

test('activation solves the challenge and emits { token, nonce } via callback and bubbling event', async () => {
  const { container } = createContainer();
  const payload = { token: 'token-1', challenge: 'challenge-a', difficulty: 0 };

  let solved = null;
  let solveOptions = null;
  const solve = async (challenge, difficulty, options) => {
    solveOptions = { challenge, difficulty, signal: options.signal };
    return 42;
  };

  const widget = mountCaptcha(container, {
    challenge: payload,
    solve,
    onSolved: (result) => {
      solved = result;
    }
  });

  const events = [];
  container.addEventListener(SOLVED_EVENT, (event) => {
    events.push(event);
  });

  const button = child(rootOf(container), 'hc-button');
  button.click();
  await delay(0);

  assert.deepEqual(solved, { token: 'token-1', nonce: 42 });
  assert.equal(solveOptions.challenge, 'challenge-a');
  assert.equal(solveOptions.difficulty, 0);
  assert.equal(solveOptions.signal instanceof AbortSignal, true);

  assert.equal(events.length, 1);
  assert.equal(events[0].bubbles, true);
  assert.deepEqual(events[0].detail, { token: 'token-1', nonce: 42 });
  assert.equal(rootOf(container).getAttribute('data-state'), 'solved');
  assert.equal(child(rootOf(container), 'hc-button').textContent, 'Verified');

  widget.destroy();
});

test('customized idle, solving, cancel, solved, and error strings are applied', async () => {
  const { container: solvingContainer } = createContainer();
  const gate = deferred();

  const solvingWidget = mountCaptcha(solvingContainer, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: () => gate.promise,
    idleLabel: 'Prove',
    solvingLabel: 'Working',
    cancelLabel: 'Stop',
    solvedLabel: 'Done',
    errorLabel: 'Oops'
  });

  const solvingRoot = rootOf(solvingContainer);
  assert.equal(child(solvingRoot, 'hc-button').textContent, 'Prove');
  assert.equal(child(solvingRoot, 'hc-cancel').textContent, 'Stop');

  child(solvingRoot, 'hc-button').click();
  await delay(0);

  assert.equal(solvingRoot.getAttribute('data-state'), 'solving');
  assert.equal(child(solvingRoot, 'hc-button').textContent, 'Working');
  assert.equal(child(solvingRoot, 'hc-status').textContent, 'Working');
  assert.equal(child(solvingRoot, 'hc-progress').hidden, false);
  assert.equal(child(solvingRoot, 'hc-cancel').hidden, false);

  gate.resolve(9);
  await delay(0);

  assert.equal(solvingRoot.getAttribute('data-state'), 'solved');
  assert.equal(child(solvingRoot, 'hc-button').textContent, 'Done');
  assert.equal(child(solvingRoot, 'hc-status').textContent, 'Done');
  solvingWidget.destroy();

  const { container: errorContainer } = createContainer();
  mountCaptcha(errorContainer, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: async () => {
      throw new Error('boom');
    },
    errorLabel: 'Oops'
  });

  const errorRoot = rootOf(errorContainer);
  child(errorRoot, 'hc-button').click();
  await delay(0);

  assert.equal(errorRoot.getAttribute('data-state'), 'error');
  assert.equal(child(errorRoot, 'hc-button').textContent, 'Oops');
  assert.equal(child(errorRoot, 'hc-status').textContent, 'Oops');
});

test('duplicate activation does not start a second solve', async () => {
  const { container } = createContainer();
  const gate = deferred();
  let solveCalls = 0;

  const widget = mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: () => {
      solveCalls += 1;
      return gate.promise;
    }
  });

  const button = child(rootOf(container), 'hc-button');
  button.click();
  button.dispatchEvent(new Event('click', { bubbles: true }));
  await delay(0);

  assert.equal(solveCalls, 1);
  assert.equal(rootOf(container).getAttribute('data-state'), 'solving');

  gate.resolve(4);
  await delay(0);
  assert.equal(rootOf(container).getAttribute('data-state'), 'solved');
  widget.destroy();
});

test('cancellation aborts the shared signal, returns to idle, and never emits a solved result', async () => {
  const { container } = createContainer();
  let signalWasAborted = false;
  let solvedCalls = 0;

  const widget = mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: (challenge, difficulty, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          signalWasAborted = true;
          reject(abortError());
        });
      }),
    onSolved: () => {
      solvedCalls += 1;
    }
  });

  const root = rootOf(container);
  child(root, 'hc-button').click();
  await delay(0);

  assert.equal(root.getAttribute('data-state'), 'solving');
  child(root, 'hc-cancel').click();
  await delay(0);

  assert.equal(signalWasAborted, true);
  assert.equal(root.getAttribute('data-state'), 'idle');
  assert.equal(child(root, 'hc-button').textContent, "I'm human");
  assert.equal(child(root, 'hc-progress').hidden, true);
  assert.equal(child(root, 'hc-cancel').hidden, true);
  assert.equal(solvedCalls, 0);

  widget.destroy();
});

test('cancellation never emits a solved result even when a solver ignores the abort signal', async () => {
  const { container } = createContainer();
  const gate = deferred();
  let solvedCalls = 0;

  mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: () => gate.promise,
    onSolved: () => {
      solvedCalls += 1;
    }
  });

  const root = rootOf(container);
  child(root, 'hc-button').click();
  await delay(0);
  child(root, 'hc-cancel').click();
  await delay(0);

  gate.resolve(123);
  await delay(0);

  assert.equal(solvedCalls, 0);
  assert.equal(root.getAttribute('data-state'), 'idle');
});

test('solver errors produce an error state and an error event without emitting solved', async () => {
  const { container } = createContainer();
  const failure = new Error('solver failed');
  let onSolvedCalls = 0;
  let onErrorArg = null;
  const errorEvents = [];

  mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: async () => {
      throw failure;
    },
    onSolved: () => {
      onSolvedCalls += 1;
    },
    onError: (error) => {
      onErrorArg = error;
    }
  });
  container.addEventListener(ERROR_EVENT, (event) => {
    errorEvents.push(event);
  });

  const root = rootOf(container);
  child(root, 'hc-button').click();
  await delay(0);

  assert.equal(root.getAttribute('data-state'), 'error');
  assert.equal(child(root, 'hc-button').textContent, 'Verification failed');
  assert.equal(child(root, 'hc-status').textContent, 'Verification failed');
  assert.equal(onSolvedCalls, 0);
  assert.equal(onErrorArg, failure);
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].detail.error, failure);
});

test('a solver AbortError rejection that is not widget cancellation still enters the error state', async () => {
  const { container } = createContainer();
  const thrown = abortError();
  let solverSignal = null;
  let onSolvedCalls = 0;
  let onErrorArg = null;
  const solvedEvents = [];
  const errorEvents = [];

  mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: (challenge, difficulty, options) => {
      solverSignal = options.signal;
      return Promise.reject(thrown);
    },
    onSolved: () => {
      onSolvedCalls += 1;
    },
    onError: (error) => {
      onErrorArg = error;
    }
  });
  container.addEventListener(SOLVED_EVENT, (event) => {
    solvedEvents.push(event);
  });
  container.addEventListener(ERROR_EVENT, (event) => {
    errorEvents.push(event);
  });

  const root = rootOf(container);
  child(root, 'hc-button').click();
  await delay(0);

  assert.equal(solverSignal instanceof AbortSignal, true);
  assert.equal(solverSignal.aborted, false);
  assert.equal(root.getAttribute('data-state'), 'error');
  assert.equal(child(root, 'hc-button').textContent, 'Verification failed');
  assert.equal(child(root, 'hc-status').textContent, 'Verification failed');
  assert.equal(onSolvedCalls, 0);
  assert.equal(solvedEvents.length, 0);
  assert.equal(onErrorArg, thrown);
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].detail.error, thrown);
});

test('malformed challenge payloads emit ERROR_EVENT/onError without emitting SOLVED_EVENT', async () => {
  const arrayPayload = [];
  arrayPayload.token = 'token-array';
  arrayPayload.challenge = 'challenge';
  arrayPayload.difficulty = 0;

  const invalidPayloads = [
    ['null', null],
    ['array', arrayPayload],
    ['missing token', { challenge: 'challenge', difficulty: 0 }],
    ['empty token', { token: '', challenge: 'challenge', difficulty: 0 }],
    ['non-string token', { token: 42, challenge: 'challenge', difficulty: 0 }],
    ['fractional difficulty', { token: 'token', challenge: 'challenge', difficulty: 1.5 }],
    ['NaN difficulty', { token: 'token', challenge: 'challenge', difficulty: NaN }],
    ['Infinity difficulty', { token: 'token', challenge: 'challenge', difficulty: Infinity }],
    ['-Infinity difficulty', { token: 'token', challenge: 'challenge', difficulty: -Infinity }],
    ['negative difficulty', { token: 'token', challenge: 'challenge', difficulty: -1 }],
    ['difficulty above range', { token: 'token', challenge: 'challenge', difficulty: 257 }]
  ];

  for (const [label, payload] of invalidPayloads) {
    const { container } = createContainer();
    let solveCalls = 0;
    let onSolvedCalls = 0;
    let onErrorArg = null;
    const solvedEvents = [];
    const errorEvents = [];

    mountCaptcha(container, {
      challenge: payload,
      solve: async () => {
        solveCalls += 1;
        return 42;
      },
      onSolved: () => {
        onSolvedCalls += 1;
      },
      onError: (error) => {
        onErrorArg = error;
      }
    });
    container.addEventListener(SOLVED_EVENT, (event) => {
      solvedEvents.push(event);
    });
    container.addEventListener(ERROR_EVENT, (event) => {
      errorEvents.push(event);
    });

    const root = rootOf(container);
    child(root, 'hc-button').click();
    await delay(0);

    assert.equal(root.getAttribute('data-state'), 'error', label);
    assert.equal(child(root, 'hc-button').textContent, 'Verification failed');
    assert.equal(child(root, 'hc-status').textContent, 'Verification failed');
    assert.equal(solveCalls, 0, label);
    assert.equal(onSolvedCalls, 0, label);
    assert.equal(solvedEvents.length, 0, label);
    assert.equal(errorEvents.length, 1, label);
    assert.ok(onErrorArg instanceof TypeError, label);
    assert.equal(errorEvents[0].detail.error, onErrorArg, label);
  }
});

test('valid challenge payload types continue through the normal solving path', async () => {
  const challengeValues = [
    ['string', 'challenge-value'],
    ['Uint8Array', new Uint8Array([1, 2, 3, 4])],
    ['ArrayBuffer', new ArrayBuffer(4)]
  ];

  for (const [label, challengeValue] of challengeValues) {
    const { container } = createContainer();
    const token = `token-${label}`;
    let solved = null;
    let onErrorCalls = 0;
    const solvedEvents = [];
    const errorEvents = [];

    mountCaptcha(container, {
      challenge: {
        token,
        challenge: challengeValue,
        difficulty: 256
      },
      solve: async () => 42,
      onSolved: (result) => {
        solved = result;
      },
      onError: () => {
        onErrorCalls += 1;
      }
    });
    container.addEventListener(SOLVED_EVENT, (event) => {
      solvedEvents.push(event);
    });
    container.addEventListener(ERROR_EVENT, (event) => {
      errorEvents.push(event);
    });

    const root = rootOf(container);
    child(root, 'hc-button').click();
    await delay(0);

    assert.equal(root.getAttribute('data-state'), 'solved', label);
    assert.deepEqual(solved, { token, nonce: 42 }, label);
    assert.equal(onErrorCalls, 0, label);
    assert.equal(errorEvents.length, 0, label);
    assert.equal(solvedEvents.length, 1, label);
    assert.deepEqual(solvedEvents[0].detail, { token, nonce: 42 }, label);
  }
});

test('malformed solver results enter the error state and never emit hashcash:solved', async () => {
  const invalidNonces = [
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative number', -1],
    ['fractional number', 1.5],
    ['integer above Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1]
  ];

  for (const [label, invalidNonce] of invalidNonces) {
    const { container } = createContainer();
    let onSolvedCalls = 0;
    let onErrorArg = null;
    const solvedEvents = [];
    const errorEvents = [];

    mountCaptcha(container, {
      challenge: {
        token: `token-${label}`,
        challenge: 'challenge',
        difficulty: 0
      },
      solve: async () => invalidNonce,
      onSolved: () => {
        onSolvedCalls += 1;
      },
      onError: (error) => {
        onErrorArg = error;
      }
    });
    container.addEventListener(SOLVED_EVENT, (event) => {
      solvedEvents.push(event);
    });
    container.addEventListener(ERROR_EVENT, (event) => {
      errorEvents.push(event);
    });

    const root = rootOf(container);
    child(root, 'hc-button').click();
    await delay(0);

    assert.equal(root.getAttribute('data-state'), 'error', label);
    assert.equal(child(root, 'hc-button').textContent, 'Verification failed');
    assert.equal(child(root, 'hc-status').textContent, 'Verification failed');
    assert.equal(onSolvedCalls, 0, label);
    assert.equal(solvedEvents.length, 0, label);
    assert.equal(errorEvents.length, 1, label);
    assert.ok(onErrorArg instanceof TypeError, label);
    assert.equal(errorEvents[0].detail.error, onErrorArg);
  }
});

test('valid boundary nonces retain the solved state and emit { token, nonce }', async () => {
  for (const validNonce of [0, Number.MAX_SAFE_INTEGER]) {
    const { container } = createContainer();
    const token = `token-${String(validNonce)}`;
    let solved = null;
    let onErrorCalls = 0;
    const solvedEvents = [];
    const errorEvents = [];

    mountCaptcha(container, {
      challenge: { token, challenge: 'challenge', difficulty: 0 },
      solve: async () => validNonce,
      onSolved: (result) => {
        solved = result;
      },
      onError: () => {
        onErrorCalls += 1;
      }
    });
    container.addEventListener(SOLVED_EVENT, (event) => {
      solvedEvents.push(event);
    });
    container.addEventListener(ERROR_EVENT, (event) => {
      errorEvents.push(event);
    });

    const root = rootOf(container);
    child(root, 'hc-button').click();
    await delay(0);

    assert.equal(root.getAttribute('data-state'), 'solved');
    assert.deepEqual(solved, { token, nonce: validNonce });
    assert.equal(onErrorCalls, 0);
    assert.equal(errorEvents.length, 0);
    assert.equal(solvedEvents.length, 1);
    assert.deepEqual(solvedEvents[0].detail, { token, nonce: validNonce });
  }
});

test('reset aborts active work and returns the widget to idle', async () => {
  const { container } = createContainer();
  let signalWasAborted = false;
  let solvedCalls = 0;

  const widget = mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: (challenge, difficulty, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          signalWasAborted = true;
          reject(abortError());
        });
      }),
    onSolved: () => {
      solvedCalls += 1;
    }
  });

  const root = rootOf(container);
  child(root, 'hc-button').click();
  await delay(0);
  assert.equal(root.getAttribute('data-state'), 'solving');

  widget.reset();
  await delay(0);

  assert.equal(signalWasAborted, true);
  assert.equal(root.getAttribute('data-state'), 'idle');
  assert.equal(child(root, 'hc-progress').hidden, true);
  assert.equal(solvedCalls, 0);

  widget.destroy();
});

test('reset returns a solved widget to idle so it can be activated again', async () => {
  const { container } = createContainer();
  let solveCalls = 0;

  const widget = mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: async () => {
      solveCalls += 1;
      return solveCalls;
    }
  });

  const root = rootOf(container);
  child(root, 'hc-button').click();
  await delay(0);
  assert.equal(root.getAttribute('data-state'), 'solved');

  widget.reset();
  assert.equal(root.getAttribute('data-state'), 'idle');
  assert.equal(child(root, 'hc-button').textContent, "I'm human");

  child(root, 'hc-button').click();
  await delay(0);
  assert.equal(solveCalls, 2);
  assert.equal(root.getAttribute('data-state'), 'solved');

  widget.destroy();
});

test('destroy aborts active work, removes the rendered widget, and removes event handlers', async () => {
  const { container } = createContainer();
  let signalWasAborted = false;
  let solveCalls = 0;

  const widget = mountCaptcha(container, {
    challenge: { token: 'token', challenge: 'challenge', difficulty: 0 },
    solve: (challenge, difficulty, options) => {
      solveCalls += 1;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          signalWasAborted = true;
          reject(abortError());
        });
      });
    }
  });

  const root = rootOf(container);
  const button = child(root, 'hc-button');
  button.click();
  await delay(0);
  assert.equal(root.getAttribute('data-state'), 'solving');

  widget.destroy();

  assert.equal(signalWasAborted, true);
  assert.equal(root.parentNode, null);
  assert.equal(container.children.length, 0);

  button.click();
  await delay(0);
  assert.equal(solveCalls, 1);
});

test('mountCaptcha validates its container and challenge source', () => {
  assert.throws(() => mountCaptcha(null, {}), TypeError);
  assert.throws(() => mountCaptcha({}, {}), TypeError);

  const { container } = createContainer();
  assert.throws(() => mountCaptcha(container, {}), TypeError);
  assert.throws(
    () => mountCaptcha(container, { challenge: {}, solve: 'not-a-function' }),
    TypeError
  );
  assert.throws(
    () => mountCaptcha(container, { challenge: {}, onSolved: 'not-a-function' }),
    TypeError
  );
  assert.throws(
    () =>
      mountCaptcha(container, {
        challenge: {},
        getChallenge: 'not-a-function'
      }),
    TypeError
  );
});
