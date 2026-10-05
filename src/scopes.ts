import type { Context, MiddlewareHandler } from 'hono';
import type { RouteConfig } from '@hono/zod-openapi';
import type { RouterEnv } from './definitions/env';
import type { RouteMiddlewareFactory } from './router';

export interface ScopeMiddlewareOptions<TVars extends object = {}, TBindings extends object = {}> {
  /**
   * Returns the set of scopes available to the current request. May be sync or async.
   * Typically reads from a context variable populated by an auth middleware. `c.var` has
   * the vars `TVars`, and `c.env` has the bindings `TBindings`.
   */
  resolve: (
    c: Context<RouterEnv<TVars, TBindings>>,
  ) => readonly string[] | Promise<readonly string[]>;

  /**
   * Optional error payload customizer. Receives the missing scopes and the context;
   * returns the JSON body to send with the 403 response.
   * Defaults to `{ error: 'E_FORBIDDEN', message: 'Missing <scopes> scope(s)' }`.
   */
  onForbidden?: (
    missingScopes: string[],
    c: Context<RouterEnv<TVars, TBindings>>,
  ) => unknown | Promise<unknown>;
}

/**
 * Builds a per-route middleware factory that enforces scopes declared on a route's
 * `security` field. Plug into `createRouter({ routeMiddleware: createScopeMiddleware(...) })`.
 *
 * Scopes are extracted from every entry in `route.security`, flattened across schemes,
 * and deduplicated. A route without scopes gets no middleware: the factory returns
 * `undefined` for it.
 *
 * `TVars` types `c.var` in `resolve` and `onForbidden`:
 * `createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes })`. The vars
 * are not checked against the contexts of the routes: give the vars that the context
 * middlewares set before the route middleware runs.
 */
export function createScopeMiddleware<TVars extends object = {}, TBindings extends object = {}>(
  options: ScopeMiddlewareOptions<TVars, TBindings>,
): RouteMiddlewareFactory;
/**
 * Context form: `TVars` are the vars of `context` and `TBindings` are its bindings, so
 * `resolve` reads them without a type argument:
 * `createScopeMiddleware(apiContext, { resolve: (c) => c.var.session.scopes })`. Only the
 * type of `context` is used.
 */
export function createScopeMiddleware<TVars extends object, TBindings extends object = {}>(
  context: { readonly vars: TVars; readonly bindings?: TBindings },
  options: ScopeMiddlewareOptions<TVars, TBindings>,
): RouteMiddlewareFactory;
export function createScopeMiddleware(
  ...args: [ScopeMiddlewareOptions] | [unknown, ScopeMiddlewareOptions]
): RouteMiddlewareFactory {
  const options = args.length === 1 ? args[0] : args[1];

  return (route) => {
    const required = extractRequiredScopes(route);

    // No scopes: no middleware, so the route does not run (or list) a no-op.
    if (required.length === 0) return;

    const middleware: MiddlewareHandler = async (c, next) => {
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

    // Name it so `showRoutes` and stack traces show which scopes a route requires. No
    // spaces or parentheses, which stack-trace parsers treat as separators.
    Object.defineProperty(middleware, 'name', {
      value: `requireScopes:${required.join('+')}`.replaceAll(/[\s()]/g, '_'),
      configurable: true,
    });

    return middleware;
  };
}

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
