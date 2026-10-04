import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import type { MiddlewareHandler, Schema } from 'hono';
import type { ZodType, ZodUnion } from 'zod';
import type { RouteContext } from '../definitions';

export type RouteConfigMethod = RouteConfig['method'];

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
 * Type-level mirror of the runtime `deepMerge` used for `createRouter({ routeDefaults })`. The
 * route (`B`) wins, except:
 *
 * - zod schema on both sides: `ZodUnion<readonly [A, B]>` (runtime `base.or(route)`);
 * - array on both sides: `(A[number] | B[number])[]` (runtime concatenates and dedupes,
 *   so no tuple length is promised);
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
        : MergeKey<A[K], B[K]>
      : B[K]
    : K extends keyof A
      ? A[K]
      : never;
};

type MergeKey<A, B> = undefined extends B
  ? A | DeepMerge<A, Exclude<B, undefined>> | Extract<B, undefined>
  : DeepMerge<A, B>;

/** No `routeDefaults` keys: the route config is returned as declared (keeps its `?` modifiers). */
type MergeBase<TBase, TRouteConfig> = [keyof TBase] extends [never]
  ? TRouteConfig
  : DeepMerge<TBase, TRouteConfig>;

export type MakeRouteFn<TPath extends string, TBase extends BaseRouteConfig = {}> = <
  TMethod extends RouteConfigMethod,
  TRouteConfig extends InputRouteConfig,
>(
  method: TMethod,
  config: TRouteConfig,
) => MergeBase<TBase, TRouteConfig> & {
  path: TPath;
  method: TMethod;
};

/** Declaration-time metadata passed to `routeMiddleware` factories and `transformRoute`. */
export interface RouteHookMeta {
  /**
   * The route's full URL path: the router's mount path joined with the route's relative
   * path (`'/'` gives the mount path itself), in Hono `:param` syntax. It is computed before
   * `transformRoute` runs and is not changed by it. A router mounted as a child (in
   * `makeRouter(context, factory, children)`) gets its parent's full path joined with its
   * own segment, so a mounted router always gets the full path, for value-form and curried
   * `defineChildRoute` contexts alike. A thunk called directly uses its context's runtime
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
export type RouteMiddlewareFactory = (route: RouteConfig, meta: RouteHookMeta) => MiddlewareHandler;

export interface CreateRouterOptions<TBase extends BaseRouteConfig = {}> {
  /**
   * Per-route middleware factories. Each factory is invoked once at route declaration
   * with the resolved `RouteConfig` and its {@link RouteHookMeta}, and must return a
   * Hono `MiddlewareHandler`. The
   * returned middlewares are attached to the route's method + path and run in array
   * order before the route's own handler.
   */
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  /**
   * Partial `RouteConfig` deep-merged into every route declared via this router.
   * Per-route values win on key conflicts; arrays are concatenated and deduplicated
   * structurally. Useful for shared `responses`, `security`, `tags`, etc. The merged
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
  transformRoute?: (config: RouteConfig, meta: RouteHookMeta) => RouteConfig;
}

type RouterFactory<
  TPath extends string,
  TVars extends object,
  TBase extends BaseRouteConfig,
  TResult,
> = (options: {
  router: OpenAPIHono<{ Variables: TVars }>;
  /** Declares a route at the path of the context. Pass the result to `router.openapi()`. */
  defineRoute: MakeRouteFn<TPath, TBase>;
  /** @deprecated Use defineRoute. Removed in 2.0. */
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

/** A child router thunk, as accepted by `makeRouter(context, factory, children)`. */
export type ChildRouterThunk = () => OpenAPIHono<any, any, any>;

/**
 * The route schema a child thunk contributes to its parent's type: the child app's
 * `Schema`. Empty (`{}`) and `any` schemas (an untyped child, or a widened
 * `(() => OpenAPIHono<any, any, any>)[]` array) contribute nothing. The schema is
 * inferred from `OpenAPIHono`, not from its base `Hono`: matching the same generic class
 * reads its type arguments directly, while matching the base class compares every member
 * (about 9x more types with 50 children).
 */
export type ChildSchema<TChild> = TChild extends () => OpenAPIHono<any, infer S extends Schema, any>
  ? 0 extends 1 & S
    ? never
    : NonEmptySchema<S>
  : never;

/** Drops empty (`{}`) members; distributes, since a child's schema is itself a union. */
type NonEmptySchema<S> = S extends unknown ? (keyof S extends never ? never : S) : never;

/**
 * Adds the children's schemas to the app's `Schema`, so `hc` / `testClient` see the
 * children's routes. Children are mounted with `app.route('/', child())` and their
 * schema keys are already full paths, so Hono's `MergeSchemaPath<S, '/'>` would not
 * change them. The schemas are intersected, as in `OpenAPIHono#route`'s own type. A
 * union also works with `hc`, but with 500 children `testClient(app)` fails with
 * TS2589 (excessively deep), while the intersection still type-checks.
 */
export type WithChildSchemas<TApp, TChildSchemas extends Schema> = [TChildSchemas] extends [never]
  ? TApp
  : TApp extends OpenAPIHono<infer E, infer S, infer B>
    ? OpenAPIHono<E, S & UnionToIntersection<TChildSchemas>, B>
    : TApp;

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

type RouterWithChildrenThunk<
  TVars extends object,
  TFactoryResult,
  TChildren extends readonly ChildRouterThunk[],
> = () => WithChildSchemas<
  FactoryReturn<TFactoryResult, OpenAPIHono<{ Variables: TVars }>>,
  ChildSchema<TChildren[number]>
>;

export interface MakeRouterFn<TBase extends BaseRouteConfig = {}> {
  /** Without children the factory may return anything (a router, a route list, ...). */
  <TPath extends string, TVars extends object, TFactoryResult>(
    context: RouteContext<TPath, TVars>,
    factory: RouterFactory<TPath, TVars, TBase, TFactoryResult | void>,
  ): RouterThunk<TVars, TFactoryResult>;
  /**
   * With children the factory must return the app the children are mounted on, or
   * nothing (the children are then mounted on the router itself). The thunk's result
   * type carries the children's route schemas, so `hc` / `testClient` on the built app
   * see the children's routes.
   */
  <
    TPath extends string,
    TVars extends object,
    TFactoryResult extends OpenAPIHono<any, any, any> | void,
    const TChildren extends readonly ChildRouterThunk[] = [],
  >(
    context: RouteContext<TPath, TVars>,
    factory: RouterFactory<TPath, TVars, TBase, TFactoryResult>,
    children?: TChildren,
  ): RouterWithChildrenThunk<TVars, TFactoryResult, TChildren>;
}
