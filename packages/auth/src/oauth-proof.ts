import { createHash, timingSafeEqual } from 'node:crypto';
import type { OneTimeTicketService, OneTimeTicketRecord } from './one-time-ticket';

/** Facts verified by a server-side provider exchange/verifier; never deserialize this from a browser. */
export interface VerifiedOAuthIdentity {
  provider: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
  avatarUrl?: string;
}

export type OAuthProofContext = {
  provider: string;
  /** Server-generated browser secret from the current request's protected cookie, not its body. */
  browserBinding: string;
} & ({ purpose: 'login' } | {
  purpose: 'link';
  /** Current authenticated account/session, never the requested target from the browser. */
  userId: string;
  sessionId: string;
});

/** Bind these fields to an existing ticket model or map them through OneTimeTicketStore. */
export interface OAuthProofRecord extends OneTimeTicketRecord {
  purpose: 'oauth_login' | 'oauth_link';
  provider: string;
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  userId: string | null;
  sessionId: string | null;
  browserBindingHash: string;
}

export class OAuthProofError extends Error {
  constructor(readonly reason: 'context' | 'identity') {
    super(`OAuth proof ${reason} is invalid`); this.name = 'OAuthProofError';
  }
}

export interface OAuthProofOptions<Credential> {
  tickets: OneTimeTicketService<OAuthProofRecord>;
  /** Must perform an authoritative provider exchange/verification after validating its stored intent. */
  verifyIdentity: (credential: Credential, context: Readonly<OAuthProofContext>) => Promise<VerifiedOAuthIdentity>;
}

const text = (value: unknown, limit = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;
const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');
function contextValid(context: OAuthProofContext): boolean {
  return Boolean(context && text(context.provider, 100) && text(context.browserBinding, 4096) &&
    (context.purpose === 'login' || (context.purpose === 'link' && text(context.userId) && text(context.sessionId))));
}
function identityValid(identity: VerifiedOAuthIdentity): boolean {
  return Boolean(identity && text(identity.provider, 100) && text(identity.subject) && typeof identity.emailVerified === 'boolean' &&
    (identity.email === undefined || text(identity.email, 320)) && (!identity.emailVerified || text(identity.email, 320)) &&
    (identity.displayName === undefined || text(identity.displayName)) && (identity.avatarUrl === undefined || text(identity.avatarUrl, 4096)));
}

/** Single-use handoff after provider verification; admission, lookup, linking and transactions stay with the consumer. */
export class OAuthProofService<Credential> {
  constructor(private readonly options: OAuthProofOptions<Credential>) {}

  async issue(credential: Credential, context: OAuthProofContext): Promise<string> {
    if (!contextValid(context)) throw new OAuthProofError('context');
    // Snapshot before an async provider call; callers cannot mutate its target while verification is pending.
    const bound = Object.freeze({ ...context });
    const identity = await this.options.verifyIdentity(credential, bound);
    if (!identityValid(identity) || identity.provider !== bound.provider) throw new OAuthProofError('identity');
    return this.options.tickets.issue({
      purpose: bound.purpose === 'login' ? 'oauth_login' : 'oauth_link', provider: identity.provider,
      providerAccountId: identity.subject, email: identity.email ?? null, emailVerified: identity.emailVerified,
      displayName: identity.displayName ?? null, avatarUrl: identity.avatarUrl ?? null,
      userId: bound.purpose === 'link' ? bound.userId : null,
      sessionId: bound.purpose === 'link' ? bound.sessionId : null,
      browserBindingHash: hash(bound.browserBinding),
    });
  }

  async consume(proof: string, context: OAuthProofContext): Promise<VerifiedOAuthIdentity> {
    if (!contextValid(context) || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw new OAuthProofError('context');
    const bound = { ...context };
    const bindingHash = hash(bound.browserBinding);
    const record = await this.options.tickets.consume(proof, ticket => {
      if (ticket.purpose !== (bound.purpose === 'login' ? 'oauth_login' : 'oauth_link') || ticket.provider !== bound.provider ||
        ticket.userId !== (bound.purpose === 'link' ? bound.userId : null) || ticket.sessionId !== (bound.purpose === 'link' ? bound.sessionId : null) ||
        !/^[a-f0-9]{64}$/.test(ticket.browserBindingHash) || !timingSafeEqual(Buffer.from(ticket.browserBindingHash), Buffer.from(bindingHash))) {
        throw new OAuthProofError('context');
      }
      if (!identityValid(this.identity(ticket))) throw new OAuthProofError('identity');
    });
    return this.identity(record);
  }

  private identity(record: OAuthProofRecord): VerifiedOAuthIdentity {
    return { provider: record.provider, subject: record.providerAccountId, email: record.email ?? undefined,
      emailVerified: record.emailVerified, displayName: record.displayName ?? undefined, avatarUrl: record.avatarUrl ?? undefined };
  }
}
