import type { Context, MiddlewareHandler } from 'hono';
import type { RouteConfig } from '@hono/zod-openapi';
import type { RouterEnv } from './definitions/env';
import type { RouteMiddlewareFactory } from './router';

export interface ScopeMiddlewareOptions<TVars extends object = {}, TBindings extends object = {}> {
  /**
   * Returns the scopes of the current request, sync or async. `c.var` has the vars `TVars`,
   * and `c.env` has the bindings `TBindings`.
   */
  resolve: (
    c: Context<RouterEnv<TVars, TBindings>>,
  ) => readonly string[] | Promise<readonly string[]>;

  /**
   * Returns the JSON body of the 403 response. The default body is
   * `{ error: 'E_FORBIDDEN', message: 'Missing <scopes> scope(s)' }`.
   */
  onForbidden?: (
    missingScopes: string[],
    c: Context<RouterEnv<TVars, TBindings>>,
  ) => unknown | Promise<unknown>;
}

/**
 * Builds a route middleware factory that requires the scopes of `route.security`, from all
 * schemes. A route without scopes gets no middleware. Pass it as
 * `createRouter({ routeMiddleware: createScopeMiddleware(...) })`.
 *
 * `TVars` types `c.var` in `resolve` and `onForbidden`:
 * `createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes })`. The vars are
 * not checked against the contexts of the routes. Give only the vars that the context
 * middlewares set.
 */
export function createScopeMiddleware<TVars extends object = {}, TBindings extends object = {}>(
  options: ScopeMiddlewareOptions<TVars, TBindings>,
): RouteMiddlewareFactory;
/**
 * Context form: `TVars` and `TBindings` come from `context`, so no type argument is necessary:
 * `createScopeMiddleware(apiContext, { resolve: (c) => c.var.session.scopes })`. Only the type
 * of `context` is used.
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

    // Stack-trace parsers read spaces and parentheses as separators, so the name has none.
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
