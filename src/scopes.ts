import type { Context } from 'hono';
import type { RouteConfig } from '@hono/zod-openapi';
import type { RouteMiddlewareFactory } from './router';

export interface ScopeMiddlewareOptions {
  /**
   * Returns the set of scopes available to the current request. May be sync or async.
   * Typically reads from a context variable populated by an auth middleware.
   */
  resolve: (c: Context) => readonly string[] | Promise<readonly string[]>;

  /**
   * Optional error payload customizer. Receives the missing scopes and the context;
   * returns the JSON body to send with the 403 response.
   * Defaults to `{ error: 'E_FORBIDDEN', message: 'Missing <scopes> scope(s)' }`.
   */
  onForbidden?: (missingScopes: string[], c: Context) => unknown | Promise<unknown>;
}

/**
 * Builds a per-route middleware factory that enforces scopes declared on a route's
 * `security` field. Plug into `createRouter({ routeMiddleware: createScopeMiddleware(...) })`.
 *
 * Scopes are extracted from every entry in `route.security`, flattened across schemes,
 * and deduplicated. If a route has no `security`, the middleware is a no-op.
 */
export const createScopeMiddleware = (
  options: ScopeMiddlewareOptions,
): RouteMiddlewareFactory => {
  return (route) => {
    const required = extractRequiredScopes(route);

    return async (c, next) => {
      if (required.length === 0) {
        await next();
        return;
      }

      const available = await options.resolve(c);
      const availableSet = new Set(available);
      const missing = required.filter((scope) => !availableSet.has(scope));

      if (missing.length > 0) {
        const body = options.onForbidden
          ? await options.onForbidden(missing, c)
          : {
              error: 'E_FORBIDDEN',
              message: `Missing ${missing.join(', ')} scope(s)`,
            };

        return c.json(body, 403);
      }

      await next();
    };
  };
};

const extractRequiredScopes = (route: RouteConfig): string[] => {
  if (!route.security || route.security.length === 0) return [];

  const seen = new Set<string>();
  for (const entry of route.security) {
    for (const scopes of Object.values(entry)) {
      if (!Array.isArray(scopes)) continue;
      for (const scope of scopes) {
        if (typeof scope === 'string') seen.add(scope);
      }
    }
  }
  return [...seen];
};
