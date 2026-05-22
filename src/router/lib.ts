import { createRoute, OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type {
  BaseRouteConfig,
  CreateRouterOptions,
  MakeRouterFn,
  RouteMiddlewareFactory,
} from './types';

type AnyRouteConfigInput = Parameters<typeof createRoute>[0];

export const createRouter = <const TBase extends BaseRouteConfig = {}>(
  options: CreateRouterOptions<TBase> = {} as CreateRouterOptions<TBase>,
): MakeRouterFn<TBase> => {
  const factories: RouteMiddlewareFactory[] = options.routeMiddleware
    ? Array.isArray(options.routeMiddleware)
      ? options.routeMiddleware
      : [options.routeMiddleware]
    : [];
  const base = options.base as Record<string, unknown> | undefined;
  const transformRoute = options.transformRoute;

  return (context, factory, children) => {
    return () => {
      const router = new OpenAPIHono().basePath(context.path);

      if (context.middlewares.length > 0) {
        router.use(...(context.middlewares as [MiddlewareHandler, ...MiddlewareHandler[]]));
      }

      const route = ((method: string, config: Record<string, unknown>) => {
        const incoming = {
          method: method as RouteConfig['method'],
          path: '/',
          ...config,
        };
        const merged = base ? deepMerge(base, incoming) : incoming;

        let declared = createRoute(merged as AnyRouteConfigInput) as RouteConfig;
        if (transformRoute) {
          declared = transformRoute(declared);
        }

        if (factories.length > 0) {
          const gated = factories.map((f) => gateByMethod(declared.method, f(declared)));
          router.use(declared.path, ...(gated as [MiddlewareHandler, ...MiddlewareHandler[]]));
        }

        return declared;
      }) as unknown as Parameters<typeof factory>[0]['route'];

      const result = factory({
        router: router as unknown as Parameters<typeof factory>[0]['router'],
        route,
      });

      if (children) {
        const app = result as OpenAPIHono;
        for (const child of children) {
          app.route('/', child());
        }
      }

      return result;
    };
  };
};

const gateByMethod = (method: string, mw: MiddlewareHandler): MiddlewareHandler => {
  const expected = method.toUpperCase();
  return async (c, next) => {
    if (c.req.method.toUpperCase() !== expected) {
      return next();
    }
    return mw(c, next);
  };
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
