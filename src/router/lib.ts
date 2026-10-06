import { createRoute, OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RouteContext } from '../definitions';
import { getRouteIdentity, joinChildPath } from '../definitions/lib';
import type {
  BaseRouteConfig,
  ChildRouter,
  CreateRouterOptions,
  MakeRouterFn,
  RouteMeta,
  RouteMiddlewareFactory,
} from './types';
import { assertRoutesAttached, attachOnOpenapi, guardOpenapi, recordRoute } from './attach';
import { deepMerge } from './deep-merge';
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
function createRouterImpl<const TBase extends BaseRouteConfig = {}>(
  options: CreateRouterOptions<TBase>,
  caller: RouterCaller,
): MakeRouterFn<TBase> {
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

  function mergeDefaults(config: AnyRouteConfigInput): AnyRouteConfigInput {
    // SAFETY: `deepMerge` returns the route config with the `routeDefaults` keys added.
    return base ? (deepMerge(base, config) as AnyRouteConfigInput) : config;
  }

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
      if (mount) {
        assertMountedUnderParent(context, mount);
      }

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

      function defineRoute(method: RouteConfig['method'], config: Record<string, unknown>) {
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

          if (mw !== undefined) {
            mws.push(mw);
          }
        }

        recordRoute(declared, router, mws);

        return declared;
      }

      if (effectiveOptions.length > 0) {
        guardOpenapi(router, fullPath, effectiveOptions);
      } else {
        attachOnOpenapi(router);
      }

      const result = callback({ app: router, router, defineRoute, route: defineRoute });

      // Limit: `instanceof` does not find an app from a second copy of zod-openapi.
      if (result !== router && result instanceof OpenAPIHono) {
        assertRoutesAttached(router, fullPath, caller);
      }

      // SAFETY: `MakeRouterFn` types the callback to return an `OpenAPIHono` or nothing.
      const app = (result ?? router) as OpenAPIHono;
      const lineage = getRouteIdentity(context)?.lineage;
      const built = (children ?? []).map((child) => child({ caller, basePath: fullPath, lineage }));

      for (const childApp of built) {
        app.route('/', childApp);
      }

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
}

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
