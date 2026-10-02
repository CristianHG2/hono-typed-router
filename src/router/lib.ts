import { createRoute, OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RouteContext } from '../definitions';
import type {
  BaseRouteConfig,
  CreateRouterOptions,
  MakeRouterFn,
  RouteHookMeta,
  RouteMiddlewareFactory,
} from './types';

type AnyRouteConfigInput = Parameters<typeof createRoute>[0];

/**
 * Builds a `makeRouter` function. Every router built from it shares the same
 * `routeDefaults`, `transformRoute` and `routeMiddleware` hooks.
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
  return createRouterImpl(options);
}

const createRouterImpl = <const TBase extends BaseRouteConfig = {}>(
  options: CreateRouterOptions<TBase> = {},
): MakeRouterFn<TBase> => {
  const factories: RouteMiddlewareFactory[] = options.routeMiddleware
    ? Array.isArray(options.routeMiddleware)
      ? options.routeMiddleware
      : [options.routeMiddleware]
    : [];

  // SAFETY: `BaseRouteConfig` is a partial route config; `deepMerge` only reads its own keys.
  // `base` is the deprecated name of `routeDefaults`; `routeDefaults` wins when both are set.
  const base = (options.routeDefaults ?? options.base) as Record<string, unknown> | undefined;
  const transformRoute = options.transformRoute;

  // SAFETY: erased implementation of `MakeRouterFn`; it returns the factory's result (or the
  // router) and mounts children, which is exactly what the generic signature describes.
  return ((
    context: RouteContext<string, object>,
    factory: (options: { router: OpenAPIHono; route: unknown }) => unknown,
    children?: (() => OpenAPIHono<any, any, any>)[],
  ) => {
    return () => {
      // A value-form child's `path` is the full path; mounting under the parent adds the
      // parent's part, so the router's own base path is the relative `segment`.
      const router = new OpenAPIHono().basePath(context.segment ?? context.path);

      if (context.middlewares.length > 0) {
        router.use(...context.middlewares);
      }

      const route = (method: RouteConfig['method'], config: Record<string, unknown>) => {
        const incoming = {
          method,
          path: '/',
          ...config,
        };

        const merged = base ? deepMerge(base, incoming) : incoming;

        // SAFETY: `merged` is `method` + `path` + a route config typed by `route()`'s callers (plus
        // the typed `routeDefaults`); `createRoute` returns a copy plus `getRoutingPath`: a `RouteConfig`.
        let declared = createRoute(merged as AnyRouteConfigInput) as RouteConfig;
        const meta: RouteHookMeta = { path: toHonoPath(joinPath(context.path, declared.path)) };

        if (transformRoute) {
          declared = transformRoute(declared, meta);
        }

        if (factories.length > 0) {
          // `on(METHOD, path)` instead of `use(path)` + a method check: Hono serves HEAD
          // through the GET handlers, so the middleware also runs for HEAD. The path is
          // converted from OpenAPI `{param}` to Hono `:param` the same way zod-openapi does
          // when it registers the route, so both match the same requests.
          const mws = factories.map((f) => f(declared, meta));
          router.on(
            declared.method.toUpperCase(),
            toHonoPath(declared.path),
            // SAFETY: `factories.length > 0`, so `mws` is non-empty. The tuple cast picks the
            // `(method, path, ...handlers)` overload of `on`; a plain `MiddlewareHandler[]`
            // spread resolves to the `(method, path[])` one.
            ...(mws as [MiddlewareHandler, ...MiddlewareHandler[]]),
          );
        }

        return declared;
      };

      const result = factory({ router, route });

      // A factory that forgets `return router` still gets its children mounted.
      // SAFETY: `MakeRouterFn` types the factory to return an `OpenAPIHono` or nothing.
      const app = (result ?? router) as OpenAPIHono;

      if (children) {
        for (const child of children) {
          app.route('/', child());
        }
      }

      // `RouterThunk` types this as the router when the factory returns nothing.
      return app;
    };
  }) as MakeRouterFn<TBase>;
};

/** OpenAPI `{param}` segments become Hono `:param` segments (same regex @hono/zod-openapi uses). */
const toHonoPath = (path: string): string => path.replaceAll(/\/{(.+?)}/g, '/:$1');

// `'/'` is the context path itself; a root defined as `''` reads as `'/'`.
const joinPath = (contextPath: string, routePath: string): string => {
  const base = contextPath.replace(/\/$/, '');

  return (routePath === '/' ? base : `${base}${routePath}`) || '/';
};

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
