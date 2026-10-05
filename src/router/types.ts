import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import type { ZodType, ZodUnion } from 'zod';
import type { RouteContext } from '../definitions';
import type { RouterEnv } from '../definitions/env';
import type { CheckChildren, ChildRouter, ChildSchema, WithChildSchemas } from './children';
import type { CheckPathParams, WithPathParams } from './path-params';

export type { ChildRouter } from './children';

/** @internal Exported for declaration emit; not part of the public API. */
export type RouteConfigMethod = RouteConfig['method'];

/** @internal Exported for declaration emit; not part of the public API. */
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
 * @internal Exported for declaration emit; not part of the public API.
 *
 * Type-level mirror of the runtime `deepMerge` used for `createRouter({ routeDefaults })`. The
 * route (`B`) wins, except:
 *
 * - zod schema on both sides: `ZodUnion<readonly [A, B]>` (runtime `base.or(route)`);
 * - array on both sides: `(A[number] | B[number])[]` (runtime concatenates and dedupes,
 *   so no tuple length is promised). Exception: a `middleware` key with a tuple on both
 *   sides gives `[...A, ...B]`, so the handler gets the vars of each middleware. The runtime
 *   removes a duplicate middleware; the type keeps it, which does not change the vars;
 * - plain object on both sides: merged key by key. A route key whose type includes
 *   `undefined` yields `A[K] | DeepMerge<A[K], B[K] without undefined> | undefined`, because
 *   the runtime keeps the base value when the key is absent and copies an explicit `undefined`.
 *
 * One key-specific rule: a route `security` that is an empty array replaces the base value
 * instead of merging, so `security: []` opts a route out of `routeDefaults.security` (OpenAPI
 * semantics). Other empty arrays, such as `tags: []`, are still additive.
 *
 * Known limitation: optional (`?`) modifiers are not preserved through the merge; a key
 * merged from an optional property is required in the result (its type keeps `undefined`).
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

// A route `security: []` (inferred as `never[]` or `[]`) replaces the base value, as at runtime.
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
 * @internal Exported for declaration emit; not part of the public API.
 *
 * Declares a route at the context path. `const` keeps literal types, so a `middleware`
 * array stays a tuple and the handler gets the vars of each middleware. `request.params` is
 * built from the context path (see {@link WithPathParams}). At runtime, the params come from
 * the path where the app is served: the full path when a parent mounts the router, and only
 * the context's own segment when you call a child router directly (for example in a test).
 * Thus a directly called child router does not get the params of its parents.
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
 * The `routeDefaults` merge and the path params, in the runtime order. Without
 * `routeDefaults` keys, the route config keeps its `?` modifiers. When the route declares no
 * params and `routeDefaults.request.params` is set, the path params are added to the merged
 * params. Otherwise they are added to the route's params before the merge.
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
   * The route's full URL path: the router's mount path joined with the route's relative
   * path (`'/'` gives the mount path itself), in Hono `:param` syntax. It is computed before
   * `transformRoute` runs and is not changed by it. A router mounted as a child (in
   * `makeRouter(context, callback, children)`) gets its parent's full path joined with its
   * own segment, so a mounted router always gets the full path, for value-form and curried
   * `defineChildContext` contexts alike. A thunk called directly uses its context's runtime
   * `path`: the full path for a root, and for a value-form child only when every ancestor
   * is a root or a value-form child. A value-form child with a curried ancestor gets a
   * partial path from that ancestor's segment; a curried child gets only its segment. A
   * root defined as `''` gives `'/'`.
   */
  readonly path: string;
}

/**
 * Builds a route's middleware from its resolved config. `route.path` is relative to the
 * router (usually `'/'`); `meta.path` is the context path joined with it.
 */
export type RouteMiddlewareFactory = (
  route: RouteConfig,
  meta: RouteMeta,
) => MiddlewareHandler | undefined;

export interface CreateRouterOptions<TBase extends BaseRouteConfig = {}> {
  /**
   * Per-route middleware factories. `defineRoute` calls each factory once with the resolved
   * `RouteConfig` and its {@link RouteMeta}. A factory returns a Hono `MiddlewareHandler`,
   * or `undefined` when the route needs no middleware. `app.openapi(route, ...)` attaches
   * the middlewares to the method and path of the route when it registers the route, so a
   * route that you declare but do not register gets no middleware. The middlewares run in
   * array order before the validators and the handler of the route, also for `HEAD` on a
   * `GET` route. See `createRouter` for the configs that `openapi` accepts.
   */
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  /**
   * Partial `RouteConfig` deep-merged into every route declared via this router.
   * Per-route values win on key conflicts; arrays are concatenated and deduplicated.
   * Plain objects and arrays are compared by structure. Functions, such as middlewares,
   * and other objects, such as class instances and Zod schemas, are compared by
   * reference. Useful for shared `responses`, `security`, `tags`, etc. The merged
   * shape is reflected in the type returned by `defineRoute()`.
   */
  routeDefaults?: TBase;
  /**
   * @deprecated Use `routeDefaults`. Removed in 2.0. When both are set, `routeDefaults`
   * wins at runtime.
   */
  base?: TBase;
  /**
   * Runtime-only transformer applied to the resolved `RouteConfig` immediately after
   * `createRoute()` (and after the `routeDefaults` merge), before `routeMiddleware` factories
   * receive it and before it is returned from `defineRoute()`. The static return type of
   * `defineRoute()` is not affected by this hook. `meta.path` is computed before this hook runs.
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
  /**
   * The `OpenAPIHono` app of the context. Register routes with `app.openapi()`. Its `Env`
   * has the vars and the bindings of the context.
   */
  app: OpenAPIHono<RouterEnv<TVars, TBindings>>;
  /** @deprecated Use app. Removed in 2.0. */
  router: OpenAPIHono<RouterEnv<TVars, TBindings>>;
  /** Declares a route at the path of the context. Pass the result to `app.openapi()`. */
  defineRoute: MakeRouteFn<TPath, TBase>;
  /** @deprecated Use defineRoute. Removed in 2.0. */
  route: MakeRouteFn<TPath, TBase>;
}) => TResult;

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * The thunk's result, matching the runtime `result ?? router`: the callback's return,
 * with any `void`/`null`/`undefined` branch replaced by the app itself.
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
 * @internal Exported for declaration emit; not part of the public API.
 *
 * `unknown`, or an error message when the callback of a `makeRouter` call without children
 * returns an `OpenAPIHono` app with no typed routes. The app type then has no routes, and a
 * test client of the router is `unknown`. This occurs when the callback registers routes in
 * separate statements and then returns `app`. The schema is read from `OpenAPIHono` itself,
 * as in {@link ChildSchema}, so a `Hono` result, such as the result of `app.use()`, is not
 * checked. A callback that returns nothing is the opt-out.
 */
export type CheckCallbackResult<TResult> =
  TResult extends OpenAPIHono<any, infer S, any>
    ? keyof S extends never
      ? 'The callback returns an app with no typed routes. Return the .openapi() chain, or return nothing.'
      : unknown
    : unknown;

export interface MakeRouterFn<TBase extends BaseRouteConfig = {}> {
  /**
   * Without children the callback may return anything (a router, a route list, ...), or
   * nothing. An `OpenAPIHono` app with no typed routes is a type error (see
   * {@link CheckCallbackResult}).
   */
  <TPath extends string, TVars extends object, TCallbackResult, TBindings extends object = {}>(
    context: RouteContext<TPath, TVars, TBindings>,
    callback: RouterCallback<TPath, TVars, TBindings, TBase, TCallbackResult | void> &
      CheckCallbackResult<TCallbackResult>,
  ): RouterThunk<TVars, TBindings, TCallbackResult>;
  /**
   * With children the callback must return the app the children are mounted on, or
   * nothing (the children are then mounted on the router itself). The thunk's result
   * type carries the children's route schemas, so `hc` / `testClient` on the built app
   * see the children's routes.
   *
   * When the thunk runs, it throws a `TypeError` in two cases. Two routes have the same
   * method and full path: the client type of that path becomes `never`. A child with a param
   * segment, such as `'/:id'`, comes before a sibling with a literal segment, such as
   * `'/stats'`: Hono matches in registration order. The order is accepted when the param
   * child has no middlewares of its own and no method in common with the sibling. Only
   * the routes that `app.openapi` registers are checked: on a router maker without options,
   * this includes a `createRoute` config.
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
