// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { OneTimeTicketService, type OneTimeTicketStore } from './one-time-ticket';
import { OAuthProofService, type OAuthProofContext, type OAuthProofRecord } from './oauth-proof';

const identity = { provider: 'google', subject: 'provider-subject', email: 'member@example.test', emailVerified: true };
const login: OAuthProofContext = { purpose: 'login', provider: 'google', browserBinding: 'server-browser-secret' };
const link: OAuthProofContext = { ...login, purpose: 'link', userId: 'user-1', sessionId: 'session-1' };
function fixture() {
  const rows: OAuthProofRecord[] = []; let clock = new Date('2026-10-24T00:00:00Z');
  const store: OneTimeTicketStore<OAuthProofRecord> = {
    create: vi.fn(async data => { rows.push({ ...data, id: `ticket-${rows.length}`, createdAt: clock, consumedAt: null } as OAuthProofRecord); }),
    find: vi.fn(async tokenHash => rows.find(row => row.tokenHash === tokenHash) ?? null),
    claim: vi.fn(async (id, now) => {
      const row = rows.find(item => item.id === id);
      if (!row || row.consumedAt || row.expiresAt <= now) return false;
      row.consumedAt = now; return true;
    }), cleanup: vi.fn(async () => {}),
  };
  const tickets = new OneTimeTicketService(store, { expirySeconds: 120, consumedRetentionSeconds: 3600, now: () => clock });
  const verifyIdentity = vi.fn(async () => identity);
  return { rows, store, verifyIdentity, tickets, service: new OAuthProofService({ tickets, verifyIdentity }),
    advance: (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); } };
}

describe('verified OAuth handoff proofs', () => {
  it('calls the server verifier and stores only a projection, hashed proof and browser binding', async () => {
    const { service, verifyIdentity, rows } = fixture();
    const proof = await service.issue('synthetic-provider-credential', login);
    expect(verifyIdentity).toHaveBeenCalledWith('synthetic-provider-credential', login);
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows[0].tokenHash).not.toBe(proof);
    expect(JSON.stringify(rows)).not.toContain('synthetic-provider-credential');
    expect(JSON.stringify(rows)).not.toContain(login.browserBinding);
    await expect(service.consume(proof, login)).resolves.toEqual({ ...identity, displayName: undefined, avatarUrl: undefined });
    await expect(service.consume(proof, login)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it.each([
    { ...link, purpose: 'login' },
    { ...link, provider: 'github' },
    { ...link, userId: 'another-user' },
    { ...link, sessionId: 'another-session' },
    { ...link, browserBinding: 'another-browser' },
  ] as OAuthProofContext[])('wrong context %o cannot burn a valid binding proof', async context => {
    const { service, store } = fixture(); const proof = await service.issue('credential', link);
    await expect(service.consume(proof, context)).rejects.toMatchObject({ reason: 'context' });
    expect(store.claim).not.toHaveBeenCalled();
    await expect(service.consume(proof, link)).resolves.toMatchObject(identity);
  });

  it('never accepts a login proof for linking and claims once across concurrent consumers', async () => {
    const { service } = fixture(); const proof = await service.issue('credential', login);
    await expect(service.consume(proof, link)).rejects.toMatchObject({ reason: 'context' });
    const results = await Promise.allSettled([service.consume(proof, login), service.consume(proof, login)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('rejects expired proofs and invalid verifier facts rather than persisting client profiles', async () => {
    const { service, verifyIdentity, rows, advance } = fixture();
    verifyIdentity.mockResolvedValueOnce({ ...identity, provider: 'github' });
    await expect(service.issue('credential', login)).rejects.toMatchObject({ reason: 'identity' }); expect(rows).toHaveLength(0);
    const proof = await service.issue('credential', link); advance(120_000);
    await expect(service.consume(proof, link)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('requires synchronous validation and never claims after an invalid validator result', async () => {
    const { service, tickets, store } = fixture(); const proof = await service.issue('credential', link);
    await expect(tickets.consume(proof, async () => {})).rejects.toThrow('synchronously');
    await expect(tickets.consume(proof, () => false)).rejects.toThrow('synchronously');
    expect(store.claim).not.toHaveBeenCalled();
    await expect(service.consume(proof, link)).resolves.toMatchObject(identity);
  });

  it('does not restore a claimed proof after a later application operation fails', async () => {
    const { service } = fixture(); const proof = await service.issue('credential', link);
    await service.consume(proof, link);
    await expect(service.consume(proof, link)).rejects.toMatchObject({ reason: 'invalid' });
  });
});
