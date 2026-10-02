import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { ZodType, ZodUnion } from 'zod';
import type { RouteContext } from '../definitions';

export type RouteConfigMethod = RouteConfig['method'];

export type InputRouteConfig = Omit<RouteConfig, 'method' | 'path'>;

export type BaseRouteConfig = Partial<InputRouteConfig>;

type IsPlainObject<T> = T extends object
  ? T extends readonly unknown[]
    ? false
    : T extends (...args: any[]) => any
      ? false
      : T extends Date
        ? false
        : T extends { _def: unknown }
          ? false
          : true
  : false;

type IsArray<T> = T extends readonly unknown[] ? true : false;

export type DeepMerge<A, B> = [A] extends [never]
  ? B
  : [B] extends [never]
    ? A
    : A extends ZodType
      ? B extends ZodType
        ? ZodUnion<readonly [A, B]>
        : B
      : [IsArray<A>, IsArray<B>] extends [true, true]
        ? [...(A extends readonly unknown[] ? A : []), ...(B extends readonly unknown[] ? B : [])]
        : [IsPlainObject<A>, IsPlainObject<B>] extends [true, true]
          ? {
              [K in keyof A | keyof B]: K extends keyof B
                ? K extends keyof A
                  ? DeepMerge<A[K], B[K]>
                  : B[K]
                : K extends keyof A
                  ? A[K]
                  : never;
            }
          : undefined extends B
            ? A
            : B;

export type MakeRouteFn<TPath extends string, TBase extends BaseRouteConfig = {}> = <
  TMethod extends RouteConfigMethod,
  TRouteConfig extends InputRouteConfig,
>(
  method: TMethod,
  config: TRouteConfig,
) => DeepMerge<TBase, TRouteConfig> & {
  path: TPath;
  method: TMethod;
};

export type RouteMiddlewareFactory = (route: RouteConfig) => MiddlewareHandler;

export interface CreateRouterOptions<TBase extends BaseRouteConfig = {}> {
  /**
   * Per-route middleware factories. Each factory is invoked once at route declaration
   * with the resolved `RouteConfig` and must return a Hono `MiddlewareHandler`. The
   * returned middlewares are attached to the route's method + path and run in array
   * order before the route's own handler.
   */
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  /**
   * Partial `RouteConfig` deep-merged into every route declared via this router.
   * Per-route values win on key conflicts; arrays are concatenated and deduplicated
   * structurally. Useful for shared `responses`, `security`, `tags`, etc. The merged
   * shape is reflected in the type returned by `route()`.
   */
  base?: TBase;
  /**
   * Runtime-only transformer applied to the resolved `RouteConfig` immediately after
   * `createRoute()` (and after the `base` merge), before `routeMiddleware` factories
   * receive it and before it is returned from `route()`. The static return type of
   * `route()` is not affected by this hook.
   */
  transformRoute?: (config: RouteConfig) => RouteConfig;
}

type RouterFactory<
  TPath extends string,
  TVars extends object,
  TBase extends BaseRouteConfig,
  TResult,
> = (options: {
  router: OpenAPIHono<{ Variables: TVars }>;
  route: MakeRouteFn<TPath, TBase>;
}) => TResult;

/**
 * The thunk's result, matching the runtime `result ?? router`: the factory's return,
 * with any `void`/`null`/`undefined` branch replaced by the router itself.
 */
export type FactoryReturn<TResult, TRouter> = [TResult] extends [void]
  ? TRouter
  :
      | Exclude<TResult, null | undefined | void>
      | ([Extract<TResult, null | undefined | void>] extends [never] ? never : TRouter);

type RouterThunk<TVars extends object, TFactoryResult> = () => FactoryReturn<
  TFactoryResult,
  OpenAPIHono<{ Variables: TVars }>
>;

export interface MakeRouterFn<TBase extends BaseRouteConfig = {}> {
  /** Without children the factory may return anything (a router, a route list, ...). */
  <TPath extends string, TVars extends object, TFactoryResult>(
    context: RouteContext<TPath, TVars>,
    factory: RouterFactory<TPath, TVars, TBase, TFactoryResult | void>,
  ): RouterThunk<TVars, TFactoryResult>;
  /**
   * With children the factory must return the app the children are mounted on, or
   * nothing (the children are then mounted on the router itself).
   */
  <
    TPath extends string,
    TVars extends object,
    TFactoryResult extends OpenAPIHono<any, any, any> | void,
  >(
    context: RouteContext<TPath, TVars>,
    factory: RouterFactory<TPath, TVars, TBase, TFactoryResult>,
    children?: (() => OpenAPIHono<any, any, any>)[],
  ): RouterThunk<TVars, TFactoryResult>;
}
