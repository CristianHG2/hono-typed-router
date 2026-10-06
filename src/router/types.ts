import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { ZodType, ZodUnion } from 'zod';
import type { RouteContext } from '../definitions';
import type { RouterEnv } from '../definitions/env';
import type { CheckChildren, ChildRouter, ChildSchema, WithChildSchemas } from './children';
import type { CheckPathParams, WithPathParams } from './path-params';

export type { ChildRouter } from './children';

/** @internal */
export type RouteConfigMethod = RouteConfig['method'];

/** @internal */
export type InputRouteConfig = Omit<RouteConfig, 'method' | 'path'>;

export type BaseRouteConfig = Partial<InputRouteConfig>;

type IsPlainObject<T> = T extends
  | readonly unknown[]
  | ((...args: any[]) => any)
  | Date
  | { _def: unknown }
  ? false
  : T extends object
    ? true
    : false;

/**
 * @internal
 *
 * The type of the runtime `deepMerge`. The route (`B`) wins, except:
 *
 * - Two zod schemas give `ZodUnion<readonly [A, B]>` (`base.or(route)`).
 * - Two arrays give `(A[number] | B[number])[]`. Two `middleware` tuples give `[...A, ...B]`.
 * - Two plain objects merge key by key. A route key that can be `undefined` gives
 *   `A[K] | DeepMerge<A[K], B[K]> | undefined`, because the runtime copies an explicit `undefined`.
 * - A route `security: []` replaces the base value. Other empty arrays merge.
 *
 * Limit: the merge drops the `?` modifier, so a key from an optional property is required.
 */
export type DeepMerge<A, B> = A extends ZodType
  ? B extends ZodType
    ? ZodUnion<readonly [A, B]>
    : B
  : A extends readonly unknown[]
    ? B extends readonly unknown[]
      ? (A[number] | B[number])[]
      : B
    : [IsPlainObject<A>, IsPlainObject<B>] extends [true, true]
      ? MergeObjects<A, B>
      : B;

// TypeScript infers `security: []` as `never[]` or `[]`.
type MergeObjects<A, B> = {
  [K in keyof A | keyof B]: K extends keyof B
    ? K extends keyof A
      ? K extends 'security'
        ? B[K] extends readonly never[]
          ? []
          : MergeKey<A[K], B[K]>
        : K extends 'middleware'
          ? MergeMiddleware<A[K], B[K]>
          : MergeKey<A[K], B[K]>
      : B[K]
    : K extends keyof A
      ? A[K]
      : never;
};

// Two tuples keep their order and length, so `RouteConfigToEnv` of zod-openapi sees each
// middleware.
type MergeMiddleware<A, B> = A extends readonly unknown[]
  ? B extends readonly unknown[]
    ? number extends A['length'] | B['length']
      ? MergeKey<A, B>
      : [...A, ...B]
    : MergeKey<A, B>
  : MergeKey<A, B>;

type MergeKey<A, B> = undefined extends B
  ? A | DeepMerge<A, Exclude<B, undefined>> | Extract<B, undefined>
  : DeepMerge<A, B>;

/**
 * @internal
 *
 * `const` keeps a `middleware` array as a tuple, so the handler gets the vars of each
 * middleware. `docs/api.md` (`makeRouter`) describes the path params and their limits.
 */
export type MakeRouteFn<TPath extends string, TBase extends BaseRouteConfig = {}> = <
  TMethod extends RouteConfigMethod,
  const TRouteConfig extends InputRouteConfig,
>(
  method: TMethod,
  config: TRouteConfig & CheckPathParams<TPath, TRouteConfig>,
) => RouteWithParams<TPath, TBase, TRouteConfig> & {
  path: TPath;
  method: TMethod;
};

/**
 * In the order of the runtime `defineRoute`: if only `routeDefaults` declares params, the
 * path params go in after the merge.
 */
type RouteWithParams<TPath extends string, TBase, C> = [keyof TBase] extends [never]
  ? WithPathParams<TPath, C>
  : TBase extends { request: { params: unknown } }
    ? C extends { request: { params: unknown } }
      ? DeepMerge<TBase, WithPathParams<TPath, C>>
      : WithPathParams<TPath, DeepMerge<TBase, C>>
    : DeepMerge<TBase, WithPathParams<TPath, C>>;

/** The metadata of a route that `routeMiddleware` factories and `transformRoute` get. */
export interface RouteMeta {
  /**
   * The full URL path of the route in Hono `:param` syntax, as Hono registers it.
   * `transformRoute` does not change it. `docs/api.md` (`RouteMeta`) gives the edge cases and
   * the limit for a router that you call directly.
   */
  readonly path: string;
}

/**
 * Makes the middleware of a route from its resolved config. `route.path` is relative to the
 * router. `meta.path` is the full path.
 */
export type RouteMiddlewareFactory = (
  route: RouteConfig,
  meta: RouteMeta,
) => MiddlewareHandler | undefined;

export interface CreateRouterOptions<TBase extends BaseRouteConfig = {}> {
  /**
   * Route middleware factories. `defineRoute` calls each one once for each route, and
   * `app.openapi()` attaches the middlewares when it registers the route. They run in array
   * order before the validators and the handler, also for `HEAD` on a `GET` route.
   */
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  /**
   * The router deep-merges this partial `RouteConfig` into each route. A route value wins, and
   * arrays join without duplicates. The type that `defineRoute()` returns has the merged shape.
   */
  routeDefaults?: TBase;
  /**
   * @deprecated Use `routeDefaults`. Removed in 2.0. When both are set, `routeDefaults`
   * wins at runtime.
   */
  base?: TBase;
  /**
   * Changes the resolved `RouteConfig` at runtime. It runs after `createRoute()` and the
   * `routeDefaults` merge, and before the `routeMiddleware` factories. It does not change the
   * type that `defineRoute()` returns.
   */
  transformRoute?: (config: RouteConfig, meta: RouteMeta) => RouteConfig;
}

type RouterCallback<
  TPath extends string,
  TVars extends object,
  TBindings extends object,
  TBase extends BaseRouteConfig,
  TResult,
> = (options: {
  /** The `OpenAPIHono` app of the context, with its vars and bindings. */
  app: OpenAPIHono<RouterEnv<TVars, TBindings>>;
  /** @deprecated Use app. Removed in 2.0. */
  router: OpenAPIHono<RouterEnv<TVars, TBindings>>;
  /** Declares a route at the path of the context. Pass the result to `app.openapi()`. */
  defineRoute: MakeRouteFn<TPath, TBase>;
  /** @deprecated Use defineRoute. Removed in 2.0. */
  route: MakeRouteFn<TPath, TBase>;
}) => TResult;

/**
 * @internal
 *
 * The type of the runtime `result ?? router`.
 */
export type FactoryReturn<TResult, TRouter> = [TResult] extends [void]
  ? TRouter
  :
      | Exclude<TResult, null | undefined | void>
      | ([Extract<TResult, null | undefined | void>] extends [never] ? never : TRouter);

type RouterThunk<
  TVars extends object,
  TBindings extends object,
  TCallbackResult,
> = () => FactoryReturn<TCallbackResult, OpenAPIHono<RouterEnv<TVars, TBindings>>>;

type RouterWithChildrenThunk<
  TVars extends object,
  TBindings extends object,
  TCallbackResult,
  TChildren extends readonly ChildRouter[],
> = () => WithChildSchemas<
  FactoryReturn<TCallbackResult, OpenAPIHono<RouterEnv<TVars, TBindings>>>,
  ChildSchema<TChildren[number]>
>;

/**
 * @internal
 *
 * A test client of an app with no typed routes is `unknown`.
 */
export type CheckCallbackResult<TResult> =
  TResult extends OpenAPIHono<any, infer S, any>
    ? keyof S extends never
      ? 'The callback returns an app with no typed routes. Return the .openapi() chain, or return nothing.'
      : unknown
    : unknown;

export interface MakeRouterFn<TBase extends BaseRouteConfig = {}> {
  /**
   * Without children, the callback returns any value or nothing. An `OpenAPIHono` app with no
   * typed routes is a type error.
   */
  <TPath extends string, TVars extends object, TCallbackResult, TBindings extends object = {}>(
    context: RouteContext<TPath, TVars, TBindings>,
    callback: RouterCallback<TPath, TVars, TBindings, TBase, TCallbackResult | void> &
      CheckCallbackResult<TCallbackResult>,
  ): RouterThunk<TVars, TBindings, TCallbackResult>;
  /**
   * With children, the callback returns the app for the children, or nothing to mount them
   * on the router. The thunk throws a `TypeError` when two routes have the same method and
   * full path, or when a param child (`'/:id'`) comes before a literal sibling (`'/stats'`)
   * and gets its requests.
   */
  <
    TPath extends string,
    TVars extends object,
    TCallbackResult extends OpenAPIHono<any, any, any> | void,
    const TChildren extends readonly ChildRouter[],
    TBindings extends object = {},
  >(
    context: RouteContext<TPath, TVars, TBindings>,
    callback: RouterCallback<TPath, TVars, TBindings, TBase, TCallbackResult>,
    children: (TChildren & CheckChildren<TChildren>) | undefined,
  ): RouterWithChildrenThunk<TVars, TBindings, TCallbackResult, TChildren>;
}
