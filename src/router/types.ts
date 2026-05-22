import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { RouteContext } from '../definitions';

export type RouteConfigMethod = RouteConfig['method'];
export type InputRouteConfig = Omit<RouteConfig, 'method' | 'path'>;

export type MakeRouteFn<TPath extends string> = <
  TMethod extends RouteConfigMethod,
  TRouteConfig extends InputRouteConfig,
>(
  method: TMethod,
  config: TRouteConfig,
) => TRouteConfig & {
  path: TPath;
  method: TMethod;
};

export type RouteMiddlewareFactory = (route: RouteConfig) => MiddlewareHandler;

export interface CreateRouterOptions {
  /**
   * Per-route middleware factories. Each factory is invoked once at route declaration
   * with the resolved `RouteConfig` and must return a Hono `MiddlewareHandler`. The
   * returned middlewares are attached to the route's method + path and run in array
   * order before the route's own handler.
   */
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
}

export type MakeRouterFn = <TPath extends string, TVars extends object, TFactoryResult>(
  context: RouteContext<TPath, TVars>,
  factory: (options: {
    router: OpenAPIHono<{ Variables: TVars }>;
    route: MakeRouteFn<TPath>;
  }) => TFactoryResult,
  children?: (() => OpenAPIHono<any, any, any>)[],
) => () => TFactoryResult;
