import { createRoute, OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RouteContext } from '../definitions';
import { getRouteIdentity, joinChildPath } from '../definitions/lib';
import type {
  BaseRouteConfig,
  CreateRouterOptions,
  MakeRouterFn,
  RouteMeta,
  RouteMiddlewareFactory,
} from './types';
import type { ChildRouter } from './children';
import { assertRoutesAttached, attachOnOpenapi, guardOpenapi, recordRoute } from './attach';
import { checkRouter } from './mount-checks';
import { assertMountedUnderParent, type RouterCaller, type RouterMount } from './mount-guard';
import { joinPath, toHonoPath, withPathParams } from './path-params';

type AnyRouteConfigInput = Parameters<typeof createRoute>[0];

/**
 * Builds a `makeRouter` function. Every router built from it shares the same
 * `routeDefaults`, `transformRoute` and `routeMiddleware` hooks.
 *
 * With one of these options set, `app.openapi` accepts only the route configs that the
 * `defineRoute` of the same callback returns. It throws a `TypeError` for a
 * `createRoute` config or for a config from another router, because the options do not
 * apply to it. Set `hide` and the other route keys in `defineRoute`: a copy such as
 * `{ ...route, hide: true }` is a different config and `openapi` does not accept it. A
 * `createRouter()` without options accepts every config, and the duplicate check of
 * `makeRouter` also reads a `createRoute` config.
 *
 * When both `routeDefaults` and the deprecated `base` are set, `routeDefaults` wins
 * at runtime and at the type level.
 */
export function createRouter<const TBase extends BaseRouteConfig = {}>(
  options: Omit<CreateRouterOptions<TBase>, 'base'> & {
    routeDefaults: TBase;
    /** @deprecated Use `routeDefaults`. Ignored when `routeDefaults` is set. */
    base?: BaseRouteConfig;
  },
): MakeRouterFn<TBase>;
/**
 * Builds a `makeRouter` function. Every router built from it shares the same
 * `routeDefaults` (or the deprecated `base`), `transformRoute` and `routeMiddleware` hooks.
 */
export function createRouter<const TBase extends BaseRouteConfig = {}>(
  options?: CreateRouterOptions<TBase>,
): MakeRouterFn<TBase>;
export function createRouter(
  options: CreateRouterOptions<BaseRouteConfig> = {},
): MakeRouterFn<BaseRouteConfig> {
  return createRouterImpl(options, 'makeRouter');
}

// `caller` is the public function that the runtime errors name.
const createRouterImpl = <const TBase extends BaseRouteConfig = {}>(
  options: CreateRouterOptions<TBase>,
  caller: RouterCaller,
): MakeRouterFn<TBase> => {
  const factories: RouteMiddlewareFactory[] = options.routeMiddleware
    ? Array.isArray(options.routeMiddleware)
      ? options.routeMiddleware
      : [options.routeMiddleware]
    : [];

  // `base` is the deprecated name of `routeDefaults`; `routeDefaults` wins when both are set.
  // SAFETY: `BaseRouteConfig` is a partial route config; `deepMerge` only reads its own keys.
  const base = (options.routeDefaults ?? options.base) as Record<string, unknown> | undefined;
  const transformRoute = options.transformRoute;

  const defaultsHaveParams =
    // SAFETY: `request` of a route config is an object when present.
    (base?.request as { params?: unknown } | undefined)?.params !== undefined;

  // The options that change a route. With one of them, a route config must come from
  // `defineRoute`, or the options do not apply to it.
  const effectiveOptions = [
    base !== undefined && Object.keys(base).length > 0 ? 'routeDefaults' : undefined,
    transformRoute === undefined ? undefined : 'transformRoute',
    factories.length > 0 ? 'routeMiddleware' : undefined,
  ].filter((name) => name !== undefined);

  const mergeDefaults = (config: AnyRouteConfigInput): AnyRouteConfigInput =>
    // SAFETY: `deepMerge` returns the route config with the `routeDefaults` keys added.
    base ? (deepMerge(base, config) as AnyRouteConfigInput) : config;

  // SAFETY: erased implementation of `MakeRouterFn`; it returns the callback's result (or the
  // router) and mounts children, which is exactly what the generic signature describes.
  return ((
    context: RouteContext<string, object>,
    callback: (options: {
      app: OpenAPIHono;
      router: OpenAPIHono;
      defineRoute: unknown;
      route: unknown;
    }) => unknown,
    children?: ((mount?: RouterMount) => OpenAPIHono<any, any, any>)[],
  ) => {
    // `mount` is internal: a parent passes it when it mounts this thunk as a child. The
    // public `RouterThunk` types stay `() => ...`.
    return (mount?: RouterMount) => {
      if (mount) assertMountedUnderParent(context, mount);

      // A value-form child's `path` is the full path; mounting under the parent adds the
      // parent's part, so the router's own base path is the relative `segment`.
      const segment = context.segment ?? context.path;
      const router = new OpenAPIHono().basePath(segment);

      // Mounted, the child serves at the parent's full path joined with its segment, in
      // every context form (a curried child's runtime `path` is only its segment). Called
      // directly, only the context's own `path` is known: the full path for a root, and for
      // a value-form child only when no ancestor is curried (a curried ancestor contributes
      // only its segment); the segment for a curried child.
      const fullPath = mount ? joinChildPath(mount.basePath, segment) : context.path;

      // The path where the app serves requests. Called directly, the app serves at its
      // segment, so the request has only the params of the segment.
      const servedPath = mount ? fullPath : segment;

      if (context.middlewares.length > 0) {
        router.use(...context.middlewares);
      }

      const defineRoute = (method: RouteConfig['method'], config: Record<string, unknown>) => {
        // SAFETY: `config` is a route config without `method` and `path`, as `MakeRouteFn`
        // types it; with both added, it is the input of `createRoute`.
        const incoming = { method, path: '/', ...config } as AnyRouteConfigInput;

        // The path params go on the route's own params, or, when the route has none and
        // `routeDefaults` has params, on the merged params. Added before the merge, they would
        // become a union with the params of `routeDefaults`.
        const merged =
          defaultsHaveParams && incoming.request?.params === undefined
            ? withPathParams(servedPath, mergeDefaults(incoming))
            : mergeDefaults(withPathParams(servedPath, incoming));

        // SAFETY: `merged` is `method` + `path` + a route config typed by `defineRoute()`'s callers (plus
        // the typed `routeDefaults`); `createRoute` returns a copy plus `getRoutingPath`: a `RouteConfig`.
        let declared = createRoute(merged as AnyRouteConfigInput) as RouteConfig;
        const meta: RouteMeta = { path: toHonoPath(joinPath(fullPath, declared.path)) };

        if (transformRoute) {
          declared = transformRoute(declared, meta);
        }

        // Build the middlewares now (one call for each declaration). `openapi` attaches them
        // when it registers the route.
        const mws: MiddlewareHandler[] = [];

        for (const f of factories) {
          const mw = f(declared, meta);

          if (mw !== undefined) mws.push(mw);
        }

        recordRoute(declared, router, mws);

        return declared;
      };

      if (effectiveOptions.length > 0) {
        guardOpenapi(router, fullPath, effectiveOptions);
      } else {
        attachOnOpenapi(router);
      }

      // `router` and `route` are the deprecated names of `app` and `defineRoute`.
      const result = callback({ app: router, router, defineRoute, route: defineRoute });

      // A different app (`instanceof`: a second copy of zod-openapi is not checked).
      if (result !== router && result instanceof OpenAPIHono)
        assertRoutesAttached(router, fullPath, caller);

      // A callback that forgets `return router` still gets its children mounted.
      // SAFETY: `MakeRouterFn` types the callback to return an `OpenAPIHono` or nothing.
      const app = (result ?? router) as OpenAPIHono;
      const lineage = getRouteIdentity(context)?.lineage;
      const built = (children ?? []).map((child) => child({ caller, basePath: fullPath, lineage }));

      for (const childApp of built) app.route('/', childApp);

      checkRouter({
        caller,
        router,
        app,
        fullPath,
        segment,
        ownMiddlewares: context.middlewares.length > 0,
        children: built,
      });

      // `RouterThunk` types this as the router when the callback returns nothing.
      return app;
    };
  }) as MakeRouterFn<TBase>;
};

/**
 * The `makeRouter` that `mountRouter` uses. It has no options, because it declares no routes.
 * The plain function type keeps the `MakeRouterFn` overloads out of `./mount`: with
 * TypeScript 7 parallel checkers, a call to them in a second module checks the `OpenAPIHono`
 * types again (about 140,000 more instantiations for each project).
 */
export const mountingRouter: (
  context: RouteContext<string, object>,
  callback: (options: { app: unknown }) => unknown,
  children: readonly ChildRouter[],
) => () => unknown = createRouterImpl({}, 'mountRouter');

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
};

type ZodSchemaLike = { _def: unknown; or: (other: unknown) => unknown };

const isZodSchema = (value: unknown): value is ZodSchemaLike => {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_def' in value &&
    // SAFETY: `value` is a non-null object; reading an optional `or` key cannot throw.
    typeof (value as { or?: unknown }).or === 'function'
  );
};

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;

  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;

    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }

    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);

    if (ak.length !== bk.length) return false;

    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;

      if (!deepEqual(a[k], b[k])) return false;
    }

    return true;
  }

  return false;
};

const mergeArrays = (base: readonly unknown[], route: readonly unknown[]): unknown[] => {
  const out: unknown[] = [...base];

  for (const item of route) {
    if (!out.some((existing) => deepEqual(existing, item))) {
      out.push(item);
    }
  }

  return out;
};

const deepMerge = (
  base: Record<string, unknown>,
  route: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };

  for (const key of Object.keys(route)) {
    const routeVal = route[key];
    const baseVal = out[key];

    if (key === 'security' && Array.isArray(routeVal) && routeVal.length === 0) {
      // OpenAPI: an operation-level `security: []` removes the inherited requirement.
      out[key] = routeVal;
    } else if (Array.isArray(baseVal) && Array.isArray(routeVal)) {
      out[key] = mergeArrays(baseVal, routeVal);
    } else if (isPlainObject(baseVal) && isPlainObject(routeVal)) {
      out[key] = deepMerge(baseVal, routeVal);
    } else if (isZodSchema(baseVal) && isZodSchema(routeVal)) {
      out[key] = baseVal.or(routeVal);
    } else {
      out[key] = routeVal;
    }
  }

  return out;
};
