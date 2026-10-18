'use strict';

/*
 * Small Firebase Realtime Database REST adapter for Vercel.
 *
 * Why this exists:
 * - The Admin RTDB SDK keeps a long-lived WebSocket. On Vercel, a warm
 *   invocation can wake up with a stale socket after the instance was frozen.
 *   The old code then waited for ref.on('value') before every transaction,
 *   with no timeout, so a POST could hang until the browser aborted it.
 * - REST requests are stateless and short-lived. Conditional PUTs with
 *   Firebase ETags provide the transaction compare-and-swap semantics that
 *   attendance-core.js needs, without a pinned listener or stale cache.
 *
 * Only the tiny Reference surface used by attendance-core.js is implemented:
 * ref(), child(), push(), get(), once(), set(), update(), remove(),
 * transaction(), and a one-shot compatibility on()/off().
 */

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRandomChars = new Array(12).fill(0);

function generatePushId(now = Date.now()) {
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;

  const timeChars = new Array(8);
  let timestamp = now;
  for (let i = 7; i >= 0; i--) {
    timeChars[i] = PUSH_CHARS.charAt(timestamp % 64);
    timestamp = Math.floor(timestamp / 64);
  }
  if (timestamp !== 0) throw new Error('Timestamp is too large for a Firebase push id.');

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) lastRandomChars[i] = Math.floor(Math.random() * 64);
  } else {
    // Increment the previous random suffix when several ids are made in the
    // same millisecond, matching Firebase's client-side push-id algorithm.
    let i = 11;
    while (i >= 0 && lastRandomChars[i] === 63) {
      lastRandomChars[i] = 0;
      i--;
    }
    if (i < 0) {
      // Extremely unlikely overflow; advancing the logical millisecond is
      // safer than returning a duplicate id.
      return generatePushId(now + 1);
    }
    lastRandomChars[i]++;
  }

  let id = timeChars.join('');
  for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandomChars[i]);
  return id;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizePath(path = '') {
  return String(path).split('/').filter(Boolean);
}

function pathToString(parts) {
  return parts.join('/');
}

function lastKey(parts) {
  return parts.length ? parts[parts.length - 1] : null;
}

function assertValidKey(key) {
  if (typeof key !== 'string' || /[.$#\[\]\/\u0000-\u001f\u007f]/.test(key)) {
    throw new Error(`Invalid Firebase database key: ${String(key)}`);
  }
}

function assertJsonValue(value, seen = new Set()) {
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw new Error('Firebase database values must be finite numbers.');
    return;
  }
  if (kind !== 'object') throw new Error(`Unsupported Firebase database value type: ${kind}`);
  if (seen.has(value)) throw new Error('Firebase database values cannot contain cycles.');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) if (item !== undefined) assertJsonValue(item, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertValidKey(key);
      if (item !== undefined) assertJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function makeSnapshot(parts, value) {
  const stored = clone(value ?? null);
  return {
    key: lastKey(parts),
    ref: null, // Filled in by RestReference when useful.
    val: () => clone(stored),
    exists: () => stored !== null,
    toJSON: () => clone(stored),
  };
}

function timeoutError(message, code = 'RTDB_REST_TIMEOUT') {
  const error = new Error(message);
  error.status = 503;
  error.code = code;
  return error;
}

class RestReference {
  constructor(database, parts) {
    this._database = database;
    this._parts = parts;
    this.key = lastKey(parts);
    this.__attendanceRest = true;
  }

  get path() {
    return pathToString(this._parts);
  }

  child(path) {
    return new RestReference(this._database, [...this._parts, ...normalizePath(path)]);
  }

  push() {
    return this.child(generatePushId());
  }

  async get() {
    const result = await this._database._request('GET', this._parts);
    const snapshot = makeSnapshot(this._parts, result.data);
    snapshot.ref = this;
    return snapshot;
  }

  once(eventType, successCallback, failureCallback) {
    if (eventType !== 'value') return Promise.reject(new Error(`Unsupported event type: ${eventType}`));
    const promise = this.get();
    if (typeof successCallback === 'function') {
      promise.then(successCallback, failureCallback).catch(() => {});
    }
    return promise;
  }

  // Compatibility only. REST has no live listener in this adapter; deliver the
  // current value once. attendance-core.js no longer uses this for REST refs.
  on(eventType, callback, failureCallback) {
    if (eventType !== 'value') throw new Error(`Unsupported event type: ${eventType}`);
    this.get().then(callback, failureCallback).catch(() => {});
    return callback;
  }

  off() {}

  async set(value) {
    assertJsonValue(value);
    await this._database._request('PUT', this._parts, { body: value ?? null });
  }

  async update(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('update() requires an object.');
    }
    assertJsonValue(values);
    if (Object.keys(values).length === 0) return;
    await this._database._request('PATCH', this._parts, { body: values });
  }

  async remove() {
    await this._database._request('DELETE', this._parts);
  }

  async transaction(updateFunction, onComplete) {
    if (typeof updateFunction !== 'function') throw new Error('transaction() requires an update function.');

    const deadline = Date.now() + this._database._transactionTimeoutMs;
    let committed = false;
    let snapshot;

    try {
      let current = await this._database._request('GET', this._parts, {
        etag: true,
        timeoutMs: this._remainingMs(deadline),
      });
      let value = current.data ?? null;
      let etag = current.etag || (value === null ? 'null_etag' : null);
      if (!etag) throw timeoutError('لم ترجع قاعدة البيانات بصمة النسخة اللازمة لحفظ ذرّي آمن.', 'RTDB_ETAG_MISSING');

      for (let attempt = 1; attempt <= this._database._transactionRetries; attempt++) {
        if (Date.now() >= deadline) {
          throw timeoutError('انتهى وقت عملية حفظ قاعدة البيانات قبل تأكيدها. أعد المحاولة بنفس البيانات.');
        }

        // The update function receives the exact server value. It may be run
        // again after a 412 conflict, just like an SDK transaction.
        const proposed = updateFunction(clone(value));
        if (proposed && typeof proposed.then === 'function') {
          throw new Error('Async RTDB transaction update functions are not supported.');
        }
        if (proposed === undefined) {
          snapshot = makeSnapshot(this._parts, value);
          snapshot.ref = this;
          if (typeof onComplete === 'function') onComplete(null, false, snapshot);
          return { committed: false, snapshot };
        }

        assertJsonValue(proposed);
        const written = await this._database._request('PUT', this._parts, {
          body: proposed ?? null,
          ifMatch: etag,
          allow412: true,
          timeoutMs: this._remainingMs(deadline),
        });

        if (written.status === 412) {
          value = written.data ?? null;
          etag = written.etag || (value === null ? 'null_etag' : null);
          if (!etag) throw timeoutError('لم ترجع قاعدة البيانات بصمة النسخة الجديدة بعد تعارض الحفظ.', 'RTDB_ETAG_MISSING');
          continue;
        }

        committed = true;
        snapshot = makeSnapshot(this._parts, written.data === undefined ? proposed : written.data);
        snapshot.ref = this;
        if (typeof onComplete === 'function') onComplete(null, true, snapshot);
        return { committed, snapshot };
      }

      const error = new Error('تعذر إتمام عملية الحفظ بسبب تعارض متكرر في قاعدة البيانات.');
      error.status = 409;
      error.code = 'RTDB_TRANSACTION_MAX_RETRIES';
      throw error;
    } catch (error) {
      if (typeof onComplete === 'function' && !snapshot) {
        try { onComplete(error, false, makeSnapshot(this._parts, null)); } catch (_) {}
      }
      throw error;
    }
  }

  _remainingMs(deadline) {
    return Math.max(250, Math.min(this._database._timeoutMs, deadline - Date.now()));
  }
}

class RestDatabase {
  constructor({ databaseURL, getAccessToken, fetchImpl, timeoutMs = 10000, transactionTimeoutMs = 15000, transactionRetries = 25 }) {
    if (!databaseURL) throw new Error('databaseURL is required.');
    if (typeof getAccessToken !== 'function') throw new Error('getAccessToken is required.');
    this._databaseURL = String(databaseURL).replace(/\/+$/, '');
    this._getAccessToken = getAccessToken;
    this._fetch = fetchImpl || globalThis.fetch;
    if (typeof this._fetch !== 'function') throw new Error('A fetch implementation is required.');
    this._timeoutMs = timeoutMs;
    this._transactionTimeoutMs = transactionTimeoutMs;
    this._transactionRetries = transactionRetries;
  }

  ref(path = '') {
    return new RestReference(this, normalizePath(path));
  }

  // SDK compatibility; REST does not hold a connection open.
  goOffline() {}
  goOnline() {}

  _url(parts) {
    const encoded = parts.map((part) => encodeURIComponent(part)).join('/');
    return `${this._databaseURL}/${encoded}.json`;
  }

  async _accessToken(timeoutMs) {
    let timer;
    try {
      const token = await Promise.race([
        this._getAccessToken(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError('انتهى وقت تجهيز اعتماد قاعدة البيانات.')), timeoutMs);
        }),
      ]);
      if (!token) throw timeoutError('تعذر تجهيز اعتماد قاعدة البيانات.', 'RTDB_ACCESS_TOKEN_MISSING');
      return token;
    } finally {
      clearTimeout(timer);
    }
  }

  async _request(method, parts, options = {}) {
    const timeoutMs = Math.max(250, options.timeoutMs || this._timeoutMs);
    const attempts = method === 'GET' ? 2 : 1;
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const token = await this._accessToken(timeoutMs);
        const headers = {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        };
        if (options.etag) headers['x-firebase-etag'] = 'true';
        if (options.ifMatch) headers['if-match'] = options.ifMatch;

        const init = { method, headers, signal: controller.signal, cache: 'no-store' };
        if (Object.prototype.hasOwnProperty.call(options, 'body')) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(options.body ?? null);
        }

        const response = await this._fetch(this._url(parts), init);
        const text = await response.text();
        let data = null;
        if (text) {
          try { data = JSON.parse(text); }
          catch (_) {
            const error = timeoutError('رجعت قاعدة البيانات برد غير صالح.', 'RTDB_INVALID_RESPONSE');
            console.error('rtdb-rest invalid JSON', method, pathToString(parts), response.status);
            throw error;
          }
        }

        const result = {
          status: response.status,
          data,
          etag: response.headers && typeof response.headers.get === 'function'
            ? response.headers.get('etag')
            : null,
        };

        if (response.status === 412 && options.allow412) return result;
        if (!response.ok) {
          const firebaseMessage = data && typeof data === 'object' ? data.error : null;
          console.error('rtdb-rest request failed', method, pathToString(parts), response.status, firebaseMessage || '');
          const error = new Error('تعذر الاتصال بقاعدة بيانات الحضور. راجع سجل Vercel وحساب خدمة Firebase ثم حاول تاني.');
          error.status = 503;
          error.code = `RTDB_REST_${response.status}`;
          throw error;
        }
        return result;
      } catch (error) {
        lastError = error;
        const aborted = error && (error.name === 'AbortError' || /aborted/i.test(error.message || ''));
        if (aborted) {
          lastError = timeoutError('انتهى وقت الاتصال بقاعدة البيانات قبل ما يرجع الرد. حاول تاني بنفس البيانات.');
        } else if (!error.status) {
          console.error('rtdb-rest network failed', method, pathToString(parts), (error.cause && (error.cause.code || error.cause.message)) || error.code || error.message);
          lastError = timeoutError('تعذر الاتصال بقاعدة بيانات الحضور. حاول تاني بنفس البيانات.', 'RTDB_REST_NETWORK');
        }
        const retryable = method === 'GET' && attempt < attempts && (!error.status || error.status >= 500);
        if (!retryable) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  }
}

function createRestDatabase(options) {
  return new RestDatabase(options);
}

module.exports = { createRestDatabase, _generatePushId: generatePushId };
