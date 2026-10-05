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
import { routeJoin, toHonoPath, withPathParams } from './path-params';

type AnyRouteConfigInput = Parameters<typeof createRoute>[0];

/**
 * Makes a `makeRouter` function. Each router from it gets the same `routeDefaults`,
 * `transformRoute` and `routeMiddleware`.
 *
 * With one of these options, `app.openapi` accepts only a config from the `defineRoute` of the
 * same callback. It throws a `TypeError` for a `createRoute` config, a config from another
 * router, or a copy such as `{ ...route, hide: true }`. Set `hide` in `defineRoute`.
 *
 * If you set `routeDefaults` and the deprecated `base`, `routeDefaults` wins.
 */
export function createRouter<const TBase extends BaseRouteConfig = {}>(
  options: Omit<CreateRouterOptions<TBase>, 'base'> & {
    routeDefaults: TBase;
    /** @deprecated Use `routeDefaults`. Ignored when `routeDefaults` is set. */
    base?: BaseRouteConfig;
  },
): MakeRouterFn<TBase>;
/**
 * Makes a `makeRouter` function. Each router from it gets the same `routeDefaults` (or the
 * deprecated `base`), `transformRoute` and `routeMiddleware`.
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

  // SAFETY: `BaseRouteConfig` is a partial route config. `deepMerge` reads only its own keys.
  const base = (options.routeDefaults ?? options.base) as Record<string, unknown> | undefined;
  const transformRoute = options.transformRoute;

  const defaultsHaveParams =
    // SAFETY: `request` of a route config is an object when present.
    (base?.request as { params?: unknown } | undefined)?.params !== undefined;

  // With one of these options, a route config must come from `defineRoute`.
  const effectiveOptions = [
    base !== undefined && Object.keys(base).length > 0 ? 'routeDefaults' : undefined,
    transformRoute === undefined ? undefined : 'transformRoute',
    factories.length > 0 ? 'routeMiddleware' : undefined,
  ].filter((name) => name !== undefined);

  const mergeDefaults = (config: AnyRouteConfigInput): AnyRouteConfigInput =>
    // SAFETY: `deepMerge` returns the route config with the `routeDefaults` keys added.
    base ? (deepMerge(base, config) as AnyRouteConfigInput) : config;

  // SAFETY: this is the erased body of `MakeRouterFn`. It returns the callback result or the
  // router, and mounts the children, as the signatures say.
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
    // A parent passes `mount` when it mounts this thunk. The public type stays `() => ...`.
    return (mount?: RouterMount) => {
      if (mount) assertMountedUnderParent(context, mount);

      // The parent adds its own path at mount, so the base path is the relative segment.
      const segment = context.segment ?? context.path;
      const router = new OpenAPIHono().basePath(segment);

      // Called directly, only the context `path` is known. See `RouteMeta.path`.
      const fullPath = mount ? joinChildPath(mount.basePath, segment) : context.path;

      // Called directly, the app serves at its segment, with only the params of the segment.
      const servedPath = mount ? fullPath : segment;

      if (context.middlewares.length > 0) {
        router.use(...context.middlewares);
      }

      const defineRoute = (method: RouteConfig['method'], config: Record<string, unknown>) => {
        // SAFETY: `MakeRouteFn` types `config` as a route config without `method` and `path`.
        const incoming = { method, path: '/', ...config } as AnyRouteConfigInput;

        // If the route has no params, add the path params after the merge. Before the merge,
        // they make a union with the params of `routeDefaults`.
        const merged =
          defaultsHaveParams && incoming.request?.params === undefined
            ? withPathParams(servedPath, mergeDefaults(incoming))
            : mergeDefaults(withPathParams(servedPath, incoming));

        // SAFETY: `merged` is a typed route config with `method` and `path`. `createRoute`
        // returns a copy with `getRoutingPath`, which is a `RouteConfig`.
        let declared = createRoute(merged as AnyRouteConfigInput) as RouteConfig;
        const meta: RouteMeta = { path: toHonoPath(routeJoin(fullPath, segment, declared.path)) };

        if (transformRoute) {
          declared = transformRoute(declared, meta);
        }

        // `openapi` attaches these middlewares when it registers the route.
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

      const result = callback({ app: router, router, defineRoute, route: defineRoute });

      // Limit: `instanceof` does not find an app from a second copy of zod-openapi.
      if (result !== router && result instanceof OpenAPIHono)
        assertRoutesAttached(router, fullPath, caller);

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

      return app;
    };
  }) as MakeRouterFn<TBase>;
};

/**
 * The `makeRouter` of `mountRouter`. The plain function type keeps the `MakeRouterFn`
 * overloads out of `./mount`. With TypeScript 7 parallel checkers, a call to them in a
 * second module costs about 140,000 more instantiations for each project.
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
    // SAFETY: `value` is a non-null object, so a read of `or` cannot throw.
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
