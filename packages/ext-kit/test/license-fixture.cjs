// Example test wire protocol, not a default Framework licensing policy.
function licensePolicy({ apiBase, purchaseUrl }) {
  return {
    purchaseUrl,
    cacheTtlMs: 12 * 60 * 60 * 1000,
    offlineGraceMs: 72 * 60 * 60 * 1000,
    requestTimeoutMs: 5000,
    retryDelayMs: 60000,
    normalizeEntitlement(value) {
      return value?.active === true && value.plan === 'pro' && typeof value.expiresAt === 'string'
        ? { active: true, plan: 'pro', expiresAt: value.expiresAt } : null;
    },
    async request(operation, input, signal) {
      const response = await fetch(`${apiBase}/extension/licenses/${operation}`, {
        signal,
        ...(operation === 'activate' ? {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: String(input.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''),
            deviceId: input.deviceId,
            deviceName: `${input.brand} · ${navigator.userAgentData?.platform || 'Chrome'}`,
          }),
        } : { headers: { Authorization: `Bearer ${input.token}` }, ...(operation === 'deactivate' ? { method: 'POST' } : {}) }),
      });
      const payload = await response.json().catch(() => null);
      const data = payload && typeof payload === 'object' ? ('result' in payload ? payload.result : payload) : null;
      const value = data?.entitlement;
      const rejected = [401, 403].includes(response.status) && payload?.status === response.status &&
        payload.result === null && typeof payload.message === 'string' && payload.message.length > 0 && Number.isFinite(payload.timestamp);
      const inactive = response.ok && value && (value.active === false ||
        (value.active === true && typeof value.plan === 'string' && value.plan !== 'pro') ||
        (typeof value.expiresAt === 'string' && Date.parse(value.expiresAt) <= Date.now()));
      return { accepted: response.ok, denied: Boolean(rejected || inactive), entitlement: value, token: data?.token, deactivated: data?.deactivated };
    },
  };
}
module.exports = { licensePolicy };
