import { createRoute, OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RouteContext } from '../definitions';
import type {
  BaseRouteConfig,
  CreateRouterOptions,
  MakeRouterFn,
  RouteMiddlewareFactory,
} from './types';

type AnyRouteConfigInput = Parameters<typeof createRoute>[0];

export const createRouter = <const TBase extends BaseRouteConfig = {}>(
  options: CreateRouterOptions<TBase> = {},
): MakeRouterFn<TBase> => {
  const factories: RouteMiddlewareFactory[] = options.routeMiddleware
    ? Array.isArray(options.routeMiddleware)
      ? options.routeMiddleware
      : [options.routeMiddleware]
    : [];

  // SAFETY: `BaseRouteConfig` is a partial route config; `deepMerge` only reads its own keys.
  const base = options.base as Record<string, unknown> | undefined;
  const transformRoute = options.transformRoute;

  // SAFETY: erased implementation of `MakeRouterFn`; it returns the factory's result (or the
  // router) and mounts children, which is exactly what the generic signature describes.
  return ((
    context: RouteContext<string, object>,
    factory: (options: { router: OpenAPIHono; route: unknown }) => unknown,
    children?: (() => OpenAPIHono<any, any, any>)[],
  ) => {
    return () => {
      const router = new OpenAPIHono().basePath(context.path);

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
        // the typed `base`); `createRoute` returns a copy plus `getRoutingPath`: a `RouteConfig`.
        let declared = createRoute(merged as AnyRouteConfigInput) as RouteConfig;

        if (transformRoute) {
          declared = transformRoute(declared);
        }

        if (factories.length > 0) {
          // `on(METHOD, path)` instead of `use(path)` + a method check: Hono serves HEAD
          // through the GET handlers, so the middleware also runs for HEAD. The path is
          // converted from OpenAPI `{param}` to Hono `:param` the same way zod-openapi does
          // when it registers the route, so both match the same requests.
          const mws = factories.map((f) => f(declared));
          router.on(
            declared.method.toUpperCase(),
            declared.path.replaceAll(/\/{(.+?)}/g, '/:$1'),
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

    if (Array.isArray(baseVal) && Array.isArray(routeVal)) {
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
