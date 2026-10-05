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

/** Arrays, functions, `Date` and zod schemas are merge leaves, as in the runtime `deepMerge`. */
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
 * The type of the runtime `deepMerge` for `createRouter({ routeDefaults })`. The route (`B`)
 * wins, with these exceptions:
 *
 * - Two zod schemas give `ZodUnion<readonly [A, B]>`, as `base.or(route)` at runtime.
 * - Two arrays give `(A[number] | B[number])[]`. Two `middleware` tuples give `[...A, ...B]`,
 *   so the handler gets the vars of each middleware.
 * - Two plain objects merge key by key. A route key that can be `undefined` gives
 *   `A[K] | DeepMerge<A[K], B[K]> | undefined`, because the runtime copies an explicit
 *   `undefined`.
 * - A route `security: []` replaces the base value. Other empty arrays merge.
 *
 * Limit: the merge drops the `?` modifier. A key from an optional property is required, and
 * its type keeps `undefined`.
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

// Two tuples keep their order and length, so `RouteConfigToEnv` sees each middleware.
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
 * Declares a route at the context path. `const` keeps a `middleware` array as a tuple, so
 * the handler gets the vars of each middleware. `request.params` comes from the context path
 * (see {@link WithPathParams}). Limit: a child router that you call directly, for example in
 * a test, does not get the params of its parents at runtime.
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
 * The `routeDefaults` merge and the path params, in the runtime order. If the route declares
 * no params and `routeDefaults.request.params` exists, the path params go into the merged
 * params. Otherwise they go into the route params before the merge.
 */
type RouteWithParams<TPath extends string, TBase, C> = [keyof TBase] extends [never]
  ? WithPathParams<TPath, C>
  : TBase extends { request: { params: unknown } }
    ? C extends { request: { params: unknown } }
      ? DeepMerge<TBase, WithPathParams<TPath, C>>
      : WithPathParams<TPath, DeepMerge<TBase, C>>
    : DeepMerge<TBase, WithPathParams<TPath, C>>;

/** Declaration-time metadata passed to `routeMiddleware` factories and `transformRoute`. */
export interface RouteMeta {
  /**
   * The full URL path of the route, in Hono `:param` syntax, as Hono registers it. It is the
   * mount path joined with the route path. A route `'/'` gives the mount path with its
   * trailing slash. A child segment `'/'` or `''` adds nothing. `transformRoute` does not
   * change it.
   *
   * Limit: a thunk that you call directly uses the runtime `path` of its context. A curried
   * child, or a value-form child with a curried ancestor, then gets a partial path. A root
   * defined as `''` gives `'/'`.
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
   * Middleware factories for each route. `defineRoute` calls each factory once with the
   * resolved `RouteConfig` and its {@link RouteMeta}. A factory returns a `MiddlewareHandler`,
   * or `undefined` for no middleware. `app.openapi()` attaches the middlewares when it
   * registers the route, so a route that you do not register gets none. They run in array
   * order before the validators and the handler, also for `HEAD` on a `GET` route.
   */
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  /**
   * A partial `RouteConfig` that is deep-merged into each route of this router. A route
   * value wins on a key conflict. Arrays are joined without duplicates. Plain objects and
   * arrays are compared by structure, and other values by reference. The type that
   * `defineRoute()` returns has the merged shape.
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
 * The result of the thunk, as the runtime `result ?? router`. A `void`, `null` or `undefined`
 * branch of the callback result becomes the app.
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
 * An error message when a `makeRouter` callback without children returns an `OpenAPIHono`
 * app with no typed routes. A test client of that router is `unknown`. This occurs when the
 * callback registers routes in separate statements and then returns `app`. A `Hono` result,
 * such as from `app.use()`, passes. A callback that returns nothing passes.
 */
export type CheckCallbackResult<TResult> =
  TResult extends OpenAPIHono<any, infer S, any>
    ? keyof S extends never
      ? 'The callback returns an app with no typed routes. Return the .openapi() chain, or return nothing.'
      : unknown
    : unknown;

export interface MakeRouterFn<TBase extends BaseRouteConfig = {}> {
  /**
   * Without children, the callback can return any value or nothing. An `OpenAPIHono` app
   * with no typed routes is a type error (see {@link CheckCallbackResult}).
   */
  <TPath extends string, TVars extends object, TCallbackResult, TBindings extends object = {}>(
    context: RouteContext<TPath, TVars, TBindings>,
    callback: RouterCallback<TPath, TVars, TBindings, TBase, TCallbackResult | void> &
      CheckCallbackResult<TCallbackResult>,
  ): RouterThunk<TVars, TBindings, TCallbackResult>;
  /**
   * With children, the callback returns the app for the children, or nothing to mount them
   * on the router. The result type has the route schemas of the children, so `hc` and
   * `testClient` see their routes.
   *
   * The thunk throws a `TypeError` in two cases:
   * - Two routes have the same method and full path. The client type of that path is `never`.
   * - A param child (`'/:id'`) comes before a literal sibling (`'/stats'`), because Hono
   *   matches in registration order. The order passes when the param child has no
   *   middlewares of its own and no method in common with the sibling.
   *
   * Only routes that `app.openapi` registers are part of these checks.
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
