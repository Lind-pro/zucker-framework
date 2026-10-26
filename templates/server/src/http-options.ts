/** Shared by the HTTP bootstrap and its actual preflight contract tests. */
export function applicationCorsOptions(env: NodeJS.ProcessEnv) {
  return {
    origin: (env.ACCOUNT_ORIGINS ?? 'http://localhost:4201,http://localhost:4202').split(',').map(value => value.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-API-Key', 'If-Match'],
    exposedHeaders: ['X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'],
  };
}
