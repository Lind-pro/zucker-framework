import { Injectable } from '@nestjs/common';
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
    };
    super(options);
  }

  abstract validate(payload: TPayload): unknown | Promise<unknown>;
}

@Injectable()
export class JwtStrategy extends JwtStrategyBase {
  validate(payload: JwtPayload): Record<string, unknown> & { id: string; username: string } {
    const { sub, ...rest } = payload;
    return { ...rest, id: sub, username: payload.username };
  }
}
