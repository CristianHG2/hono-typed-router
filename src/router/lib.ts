import { createRoute, OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { CreateRouterOptions, MakeRouterFn, RouteMiddlewareFactory } from './types';

type AnyRouteConfigInput = Parameters<typeof createRoute>[0];

export const createRouter = (options: CreateRouterOptions = {}): MakeRouterFn => {
  const factories: RouteMiddlewareFactory[] = options.routeMiddleware
    ? Array.isArray(options.routeMiddleware)
      ? options.routeMiddleware
      : [options.routeMiddleware]
    : [];

  return (context, factory, children) => {
    return () => {
      const router = new OpenAPIHono().basePath(context.path);

      if (context.middlewares.length > 0) {
        router.use(...(context.middlewares as [MiddlewareHandler, ...MiddlewareHandler[]]));
      }

      const route = ((method: string, config: Record<string, unknown>) => {
        const declared = createRoute({
          method: method as RouteConfig['method'],
          path: '/',
          ...config,
        } as AnyRouteConfigInput) as RouteConfig;

        if (factories.length > 0) {
          const gated = factories.map((f) => gateByMethod(declared.method, f(declared)));
          router.use(declared.path, ...(gated as [MiddlewareHandler, ...MiddlewareHandler[]]));
        }

        return declared;
      }) as Parameters<typeof factory>[0]['route'];

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
