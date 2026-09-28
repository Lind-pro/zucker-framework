function cancelled() {
  return new Error("Cancelled");
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelled();
}
function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(cancelled());
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function delay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
function normalizeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function storageCall(area, method, value) {
  return new Promise((resolve, reject) =>
    chrome.storage[area][method](value, (result) => {
      const error = chrome.runtime.lastError;
      error ? reject(new Error(error.message)) : resolve(result);
    }),
  );
}
const storageGet = (keys) => storageCall("local", "get", keys);
const storageSet = (value) => storageCall("local", "set", value);
const storageRemove = (keys) => storageCall("local", "remove", keys);

export { cancelled, throwIfAborted, withAbort, delay, clamp, normalizeError, storageCall, storageGet, storageSet, storageRemove };
