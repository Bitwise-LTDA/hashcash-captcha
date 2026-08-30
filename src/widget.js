/**
 * Framework-agnostic browser CAPTCHA widget.
 *
 * This module is a browser-compatible ES module with no Node.js imports and no
 * UI-framework dependencies. It renders a small, self-contained "I'm human"
 * control into a caller-supplied DOM element. Activating the control obtains a
 * `{ token, challenge, difficulty }` payload, runs the existing automatic
 * WebGPU/JavaScript solver from `./client.js`, and delivers
 * `{ token, nonce }` through both an `onSolved` callback and a bubbling custom
 * event.
 *
 * All markup and styles live inside the element returned to the caller, so the
 * widget never injects stylesheets or other nodes into the surrounding page.
 */

import { solveAuto } from './client.js';

export const SOLVED_EVENT = 'hashcash:solved';
export const ERROR_EVENT = 'hashcash:error';

const DEFAULT_IDLE_LABEL = "I'm human";
const DEFAULT_SOLVING_LABEL = 'Verifying…';
const DEFAULT_CANCEL_LABEL = 'Cancel';
const DEFAULT_SOLVED_LABEL = 'Verified';
const DEFAULT_ERROR_LABEL = 'Verification failed';

let widgetSequence = 0;

function getDocument(container) {
  if (container && container.ownerDocument) {
    return container.ownerDocument;
  }
  if (typeof document !== 'undefined') {
    return document;
  }
  return undefined;
}

function createBubblingEvent(target, type, detail) {
  if (typeof CustomEvent === 'function') {
    return new CustomEvent(type, {
      detail,
      bubbles: true,
      composed: true
    });
  }

  const doc = getDocument(target);
  if (doc && typeof doc.createEvent === 'function') {
    const event = doc.createEvent('CustomEvent');
    event.initCustomEvent(type, true, true, detail);
    return event;
  }

  if (typeof Event === 'function') {
    const event = new Event(type, { bubbles: true, composed: true });
    try {
      Object.defineProperty(event, 'detail', {
        configurable: true,
        value: detail
      });
    } catch {
      // Some environments do not allow expando properties on Event objects.
    }
    return event;
  }

  return { type, bubbles: true, composed: true, detail };
}

function resolveLabels(options) {
  return {
    idle: options.idleLabel ?? DEFAULT_IDLE_LABEL,
    solving: options.solvingLabel ?? DEFAULT_SOLVING_LABEL,
    cancel: options.cancelLabel ?? DEFAULT_CANCEL_LABEL,
    solved: options.solvedLabel ?? DEFAULT_SOLVED_LABEL,
    error: options.errorLabel ?? DEFAULT_ERROR_LABEL
  };
}

function isValidChallenge(challenge) {
  return (
    typeof challenge === 'string' ||
    challenge instanceof Uint8Array ||
    challenge instanceof ArrayBuffer
  );
}

function assertPayload(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('CAPTCHA challenge payload must be an object');
  }
  if (Array.isArray(payload)) {
    throw new TypeError('CAPTCHA challenge payload must not be an array');
  }
  if (!('token' in payload)) {
    throw new TypeError('CAPTCHA challenge payload must include a token');
  }
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new TypeError(
      'CAPTCHA challenge payload token must be a non-empty string'
    );
  }
  if (!('challenge' in payload)) {
    throw new TypeError('CAPTCHA challenge payload must include a challenge');
  }
  if (!isValidChallenge(payload.challenge)) {
    throw new TypeError(
      'CAPTCHA challenge payload challenge must be a string, Uint8Array, or ArrayBuffer'
    );
  }
  if (
    typeof payload.difficulty !== 'number' ||
    !Number.isInteger(payload.difficulty) ||
    payload.difficulty < 0 ||
    payload.difficulty > 256
  ) {
    throw new TypeError(
      'CAPTCHA challenge payload difficulty must be an integer between 0 and 256'
    );
  }
}

function buildCss(id) {
  return `
[data-hc-widget="${id}"] {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 1rem;
  line-height: 1.25;
  color: #1f2933;
}
[data-hc-widget="${id}"],
[data-hc-widget="${id}"] *,
[data-hc-widget="${id}"] *::before,
[data-hc-widget="${id}"] *::after {
  box-sizing: border-box;
}
[data-hc-widget="${id}"] .hc-button,
[data-hc-widget="${id}"] .hc-cancel {
  appearance: none;
  margin: 0;
  border: 1px solid #9aa5b1;
  border-radius: 0.375rem;
  padding: 0.5rem 0.875rem;
  background: #f5f7fa;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
[data-hc-widget="${id}"] .hc-button:disabled {
  cursor: default;
  opacity: 0.7;
}
[data-hc-widget="${id}"] .hc-button:focus-visible,
[data-hc-widget="${id}"] .hc-cancel:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
[data-hc-widget="${id}"] .hc-progress {
  width: 5rem;
  height: 0.375rem;
  overflow: hidden;
  border-radius: 9999px;
  background: #e4e7eb;
}
[data-hc-widget="${id}"] .hc-progress-bar {
  display: block;
  width: 50%;
  height: 100%;
  border-radius: inherit;
  background: #2563eb;
  animation: hc-indeterminate-${id} 0.9s linear infinite;
}
@keyframes hc-indeterminate-${id} {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}
[data-hc-widget="${id}"][data-state="solving"] .hc-button {
  border-color: #b7791f;
  background: #fef3c7;
}
[data-hc-widget="${id}"][data-state="solved"] .hc-button {
  border-color: #2f855a;
  background: #c6f6d5;
}
[data-hc-widget="${id}"][data-state="error"] .hc-button {
  border-color: #c53030;
  background: #fed7d7;
}
[data-hc-widget="${id}"] .hc-status {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (prefers-reduced-motion: reduce) {
  [data-hc-widget="${id}"] .hc-progress-bar {
    animation: none;
  }
}
`;
}

/**
 * Mount a self-contained CAPTCHA widget into a DOM element.
 *
 * @param {Element} container Existing DOM element the widget is appended to.
 * @param {object} [options]
 * @param {{ token: string, challenge: string|Uint8Array|ArrayBuffer,
 *   difficulty: number }} [options.challenge] Challenge payload used when no
 *   `getChallenge` callback is supplied.
 * @param {(context: { signal: AbortSignal }) => Promise<object>}
 *   [options.getChallenge] Async callback that returns a challenge payload.
 * @param {(result: { token: string, nonce: number }) => void}
 *   [options.onSolved] Called with the solved `{ token, nonce }` result.
 * @param {(error: Error) => void} [options.onError] Called when solving fails
 *   with a non-cancellation error.
 * @param {(challenge: string|Uint8Array|ArrayBuffer, difficulty: number,
 *   options: object) => Promise<number>} [options.solve] Solver used instead of
 *   the default `solveAuto`. Intended for tests and custom solver adapters.
 * @param {string} [options.idleLabel="I'm human"]
 * @param {string} [options.solvingLabel="Verifying…"]
 * @param {string} [options.cancelLabel="Cancel"]
 * @param {string} [options.solvedLabel="Verified"]
 * @param {string} [options.errorLabel="Verification failed"]
 * @returns {{ reset(): void, destroy(): void }} Widget lifecycle handle.
 */
export function mountCaptcha(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('mountCaptcha requires a DOM container element');
  }

  const doc = getDocument(container);
  if (!doc || typeof doc.createElement !== 'function') {
    throw new TypeError(
      'mountCaptcha requires a container with an ownerDocument'
    );
  }

  if (
    options.getChallenge !== undefined &&
    typeof options.getChallenge !== 'function'
  ) {
    throw new TypeError('options.getChallenge must be a function');
  }

  const getChallenge =
    typeof options.getChallenge === 'function' ? options.getChallenge : null;
  const directPayload = options.challenge;

  if (getChallenge === null && directPayload === undefined) {
    throw new TypeError(
      'mountCaptcha requires either options.challenge or options.getChallenge'
    );
  }

  const solve = options.solve ?? options.solveAuto ?? solveAuto;
  if (typeof solve !== 'function') {
    throw new TypeError('options.solve must be a function');
  }

  const onSolved =
    options.onSolved === undefined ? null : options.onSolved;
  const onError = options.onError === undefined ? null : options.onError;
  if (onSolved !== null && typeof onSolved !== 'function') {
    throw new TypeError('options.onSolved must be a function');
  }
  if (onError !== null && typeof onError !== 'function') {
    throw new TypeError('options.onError must be a function');
  }

  const labels = resolveLabels(options);
  const id = `hc-${++widgetSequence}-${Math.random().toString(36).slice(2, 8)}`;

  const root = doc.createElement('div');
  root.setAttribute('data-hc-widget', id);
  root.setAttribute('data-state', 'idle');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Proof-of-work CAPTCHA');
  root.setAttribute('aria-busy', 'false');

  const style = doc.createElement('style');
  style.textContent = buildCss(id);

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'hc-button';
  button.textContent = labels.idle;
  button.disabled = false;

  const progress = doc.createElement('div');
  progress.className = 'hc-progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.hidden = true;

  const progressBar = doc.createElement('span');
  progressBar.className = 'hc-progress-bar';
  progress.appendChild(progressBar);

  const cancelButton = doc.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'hc-cancel';
  cancelButton.textContent = labels.cancel;
  cancelButton.hidden = true;

  const status = doc.createElement('p');
  status.className = 'hc-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('id', `${id}-status`);
  status.textContent = labels.idle;

  button.setAttribute('aria-describedby', status.getAttribute('id'));

  root.appendChild(style);
  root.appendChild(button);
  root.appendChild(progress);
  root.appendChild(cancelButton);
  root.appendChild(status);
  container.appendChild(root);

  const labelFor = {
    idle: labels.idle,
    solving: labels.solving,
    solved: labels.solved,
    error: labels.error
  };

  let state = 'idle';
  let activeController = null;
  let destroyed = false;

  function setState(nextState) {
    state = nextState;
    root.setAttribute('data-state', nextState);
    root.setAttribute('aria-busy', nextState === 'solving' ? 'true' : 'false');
    button.textContent = labelFor[nextState];
    button.disabled = nextState === 'solving' || nextState === 'solved';
    progress.hidden = nextState !== 'solving';
    cancelButton.hidden = nextState !== 'solving';
    status.textContent = labelFor[nextState];
  }

  function emitSolved(result) {
    root.dispatchEvent(createBubblingEvent(root, SOLVED_EVENT, result));
    if (onSolved !== null) {
      onSolved(result);
    }
  }

  function emitError(error) {
    root.dispatchEvent(
      createBubblingEvent(root, ERROR_EVENT, { error })
    );
    if (onError !== null) {
      onError(error);
    }
  }

  async function obtainChallenge(signal) {
    if (getChallenge !== null) {
      return await getChallenge({ signal });
    }
    return directPayload;
  }

  async function activate() {
    if (state === 'solving' || destroyed) {
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    setState('solving');

    let payload;
    let nonce;

    try {
      payload = await obtainChallenge(controller.signal);
      if (controller.signal.aborted || destroyed) {
        return;
      }

      assertPayload(payload);
      nonce = await solve(payload.challenge, payload.difficulty, {
        signal: controller.signal
      });
      if (controller.signal.aborted || destroyed) {
        return;
      }
    } catch (error) {
      if (controller.signal.aborted || destroyed) {
        return;
      }
      setState('error');
      emitError(error);
      return;
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }

    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      setState('error');
      emitError(
        new TypeError(
          'CAPTCHA solver must return a non-negative safe integer nonce'
        )
      );
      return;
    }

    setState('solved');
    emitSolved({ token: payload.token, nonce });
  }

  function cancel() {
    if (state !== 'solving' || destroyed) {
      return;
    }
    if (activeController !== null) {
      activeController.abort();
    }
    setState('idle');
  }

  function reset() {
    if (destroyed) {
      return;
    }
    if (state === 'solving' && activeController !== null) {
      activeController.abort();
    }
    setState('idle');
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    if (activeController !== null) {
      activeController.abort();
    }

    button.removeEventListener('click', onActivate);
    cancelButton.removeEventListener('click', onCancel);
    root.removeEventListener('keydown', onKeyDown);

    if (root.parentNode !== null && typeof root.parentNode.removeChild === 'function') {
      root.parentNode.removeChild(root);
    }

    activeController = null;
  }

  function onActivate() {
    activate();
  }

  function onCancel() {
    cancel();
  }

  function onKeyDown(event) {
    if (event && event.key === 'Escape' && state === 'solving') {
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      cancel();
    }
  }

  button.addEventListener('click', onActivate);
  cancelButton.addEventListener('click', onCancel);
  root.addEventListener('keydown', onKeyDown);

  return {
    reset,
    destroy
  };
}
