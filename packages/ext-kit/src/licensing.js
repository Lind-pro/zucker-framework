import { storageGet, storageSet, storageRemove, withAbort } from './util.js';
function createLicensing(product, brand, config) {
  for (const key of ['cacheTtlMs', 'offlineGraceMs', 'requestTimeoutMs', 'retryDelayMs']) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || (key === 'requestTimeoutMs' && !config[key]))
      throw new RangeError(`Invalid licensing ${key}`);
  }
  const TOKEN_KEY = `${product}_license_token`;
  const ENTITLEMENT_KEY = `${product}_entitlement`;
  const DEVICE_KEY = `${product}_device_id`;
  let refresh = null;
  let nextRefreshAt = 0;
  let generation = 0;
  let mutation = false;
  let lastStatus = null;
  const unavailable = () => ({
    state: "unavailable",
    message:
      "Could not verify your saved Pro license. Check your connection and use Recheck Pro in License. Your activation is still saved.",
  });
  const proStatus = (entitlement) => ({ state: "pro", entitlement });
  function fallbackStatus(cached) {
    if (lastStatus?.state === "invalid") return lastStatus;
    const cachedEntitlement = usableCache(cached);
    return cachedEntitlement ? proStatus(cachedEntitlement) : unavailable();
  }
  function normalize(value) {
    if (!value || value.invalid === true) return null;
    const normalized = config.normalizeEntitlement(value);
    if (!normalized || typeof normalized.expiresAt !== 'string') return null;
    const expires = Date.parse(normalized.expiresAt);
    return Number.isFinite(expires) && expires > Date.now() ? normalized : null;
  }
  function usableCache(cached) {
    const age = Date.now() - Number(cached?.checkedAt);
    return Number.isFinite(age) && age >= 0 && age < config.offlineGraceMs
      ? normalize(cached)
      : null;
  }
  async function request(operation, input = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      // The consumer owns URLs, wire format and authoritative denial detection.
      // A non-cooperative transport still cannot keep this lifecycle pending forever.
      return await withAbort(Promise.resolve().then(() => config.request(operation, input, controller.signal)), controller.signal);
    } catch {
      throw new Error(
        "License service unreachable. Check your connection and retry.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  async function getDeviceId() {
    const stored = await storageGet(DEVICE_KEY);
    if (stored[DEVICE_KEY]) return stored[DEVICE_KEY];
    const id = crypto.randomUUID();
    await storageSet({ [DEVICE_KEY]: id });
    return id;
  }
  async function activate(code) {
    if (mutation) throw new Error("A license change is already in progress");
    mutation = true;
    generation += 1;
    try {
      const deviceId = await getDeviceId();
      const data = await request("activate", { code, deviceId, brand });
      if (!data.accepted)
        throw new Error(data.denied ? "Invalid or expired code, or its device limit is reached." : "Activation failed. Please retry later.");
      const entitlement = normalize(data?.entitlement);
      if (!entitlement || typeof data?.token !== "string" || !data.token)
        throw new Error(
          "License service returned invalid activation data. Please retry.",
        );
      await storageSet({
        [TOKEN_KEY]: data.token,
        [ENTITLEMENT_KEY]: { ...entitlement, checkedAt: Date.now() },
      });
      nextRefreshAt = 0;
      lastStatus = proStatus(entitlement);
      return entitlement;
    } finally {
      mutation = false;
    }
  }
  async function refreshEntitlement(token, cached, version) {
    try {
      const data = await request("me", { token });
      if (version !== generation) return null;
      if (data.denied === true) {
        const denied = {
          state: "invalid",
          message:
            "Your saved Pro license could not be validated. Use Recheck Pro or enter your original activation code in License to restore it.",
        };
        // The service's rejection is authoritative even when local storage
        // fails. Never let the catch/fresh-cache paths revive this grant.
        lastStatus = denied;
        try {
          await storageRemove(ENTITLEMENT_KEY);
        } catch {
          // Persist an inactive marker when removal alone failed, retaining
          // the saved token for a subsequent explicit recheck/restoration.
          await storageSet({
            [ENTITLEMENT_KEY]: { invalid: true, active: false, checkedAt: Date.now() },
          }).catch(() => {
            console.warn(
              `${brand}: rejected license cache could not be invalidated`,
            );
          });
        }
        return denied;
      }
      const entitlement = data.accepted ? normalize(data.entitlement) : null;
      if (entitlement) {
        await storageSet({
          [ENTITLEMENT_KEY]: { ...entitlement, checkedAt: Date.now() },
        });
        return proStatus(entitlement);
      }
      return fallbackStatus(cached);
    } catch {
      if (version !== generation) return null;
      return fallbackStatus(cached);
    }
  }
  async function getStatus({ cachedOnly = false, force = false } = {}) {
    const data = await storageGet([TOKEN_KEY, ENTITLEMENT_KEY]);
    const token = data[TOKEN_KEY],
      cached = data[ENTITLEMENT_KEY];
    if (!token) return { state: "free" };
    const valid =
      lastStatus?.state === "invalid" ? null : usableCache(cached);
    if (!force && valid && Date.now() - cached.checkedAt < config.cacheTtlMs)
      return proStatus(valid);
    if (mutation) return { state: "checking", refreshing: true };
    if (!refresh && (force || Date.now() >= nextRefreshAt)) {
      const version = generation;
      // One refresh per extension; failed requests back off instead of following popup polling.
      nextRefreshAt = Date.now() + config.retryDelayMs;
      refresh = refreshEntitlement(token, cached, version)
        .then((status) => {
          if (version === generation && status) lastStatus = status;
          return status;
        })
        .finally(() => {
          refresh = null;
        });
    }
    if (refresh && !cachedOnly) {
      const status = await refresh;
      return status || getStatus();
    }
    // Never reuse a Pro result after its persisted cache/expiry stops being valid.
    const remembered = lastStatus?.state === "pro" ? null : lastStatus;
    const status = valid
      ? proStatus(valid)
      : refresh
        ? { state: "checking" }
        : remembered || unavailable();
    return { ...status, refreshing: Boolean(refresh) };
  }
  async function getEntitlement(options) {
    return (await getStatus(options)).entitlement || null;
  }
  async function deactivate() {
    if (mutation) throw new Error("A license change is already in progress");
    mutation = true;
    generation += 1;
    try {
      const data = await storageGet(TOKEN_KEY);
      if (data[TOKEN_KEY]) {
        const result = await request("deactivate", { token: data[TOKEN_KEY] });
        // Preserve the local token on failure, so a failed release can be retried safely.
        if (!result.accepted || result.deactivated !== true)
          throw new Error(
            "Could not release this device. Your license is still saved; please retry.",
          );
      }
      await storageRemove([TOKEN_KEY, ENTITLEMENT_KEY]);
      nextRefreshAt = 0;
      lastStatus = null;
    } finally {
      mutation = false;
    }
  }
  return {
    activate,
    getEntitlement,
    getStatus,
    deactivate,
    purchaseUrl: config.purchaseUrl,
  };
}

export { createLicensing };
