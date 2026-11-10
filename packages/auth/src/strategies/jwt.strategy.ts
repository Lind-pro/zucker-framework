import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt, type StrategyOptionsWithoutRequest } from 'passport-jwt';

export interface JwtPayload {
  sub: string;
  username: string;
  [key: string]: unknown;
}

export abstract class JwtStrategyBase<TPayload = JwtPayload> extends PassportStrategy(Strategy) {
  constructor(secret: string) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      algorithms: ['HS256'],
    };
    super(options);
  }

  abstract validate(payload: TPayload): unknown | Promise<unknown>;
}

/** Token-type claims that mark a JWT as something other than an access token. */
const TOKEN_TYPE_CLAIMS = ['typ', 'token_type', 'tokenType'] as const;

/**
 * Reject JWTs signed with the module secret that are not access tokens: OAuth state
 * (`purpose`), refresh tokens (`typ: 'refresh'`), or payloads without a subject.
 * Tokens without a type claim are accepted for backwards compatibility.
 */
export function isAccessTokenPayload(payload: unknown): payload is JwtPayload {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  if (typeof record.sub !== 'string' || !record.sub) return false;
  if (record.purpose !== undefined) return false;
  return TOKEN_TYPE_CLAIMS.every((claim) => record[claim] === undefined || record[claim] === 'access');
}

@Injectable()
export class JwtStrategy extends JwtStrategyBase {
  validate(payload: JwtPayload): Record<string, unknown> & { id: string; username: string } {
    if (!isAccessTokenPayload(payload)) {
      throw new UnauthorizedException('Invalid access token');
    }
    const { sub, ...rest } = payload;
    return { ...rest, id: sub, username: payload.username };
  }
}
