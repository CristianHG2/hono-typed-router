import type { MiddlewareHandler } from 'hono';
import type { BindKey, BindLoader, BindParam } from './bind';
import type { ChildPath } from './path';
import type {
  CheckMiddlewareFits,
  ContextBindings,
  HandlerBindings,
  HandlerSets,
  READS,
  RouterEnv,
  SETS,
} from './env';
import type { CheckRootArray, FoldBindings, FoldVars } from './root-array';

export type { HandlerReads, HandlerSets, HandlerVars, READS, SETS } from './env';

/**
 * Constraint for a `.middleware<TNewVars>()` type argument: every key that already
 * exists in `TOld` maps to an error string, so redeclaring a var fails on the type
 * argument itself (one TS2344) rather than on the handler.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type NoRedeclare<TNew, TOld> = {
  [K in keyof TNew]: K extends keyof TOld
    ? `Cannot redeclare existing var: ${K & string}`
    : TNew[K];
};

export interface MiddlewareFactory<
  TPath extends string,
  TVars extends object,
  TBindings extends object = {},
> {
  /**
   * An inline handler: `c` has the vars of the context plus `TNewVars`, and `c.env` has the
   * bindings of the context. Must stay first, so that TypeScript tries it first and an error
   * in the handler body stays in the body. An explicit type argument always selects this
   * signature. On a context with bindings, a middleware typed only with `Variables` does not
   * fit this signature, so it uses the next one.
   */
  <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<RouterEnv<TVars & TNewVars, TBindings>, TPath>,
  ): RouteContext<TPath, TVars & TNewVars, TBindings>;
  /**
   * A middleware typed only with `Variables`, on a context with bindings. It does not fit the
   * signature above: Hono's `Context<E>` accepts only an `Env` with the same `Bindings` and
   * `Variables`, and its `Env` has no `Bindings`. This signature keeps the behaviour of a
   * context without bindings. The same middleware a second time adds no vars, and a wider
   * `{ Variables: V & W }` middleware on a context with `V` adds `W`. On a context without
   * bindings, the signature above matches first.
   */
  <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
  ): RouteContext<TPath, TVars & TNewVars, TBindings>;
  /**
   * A reusable middleware with its own `Env`: `createMiddleware<{ Variables: NewVars }>` or
   * `createMiddleware<ContextEnv<typeof ctx, NewVars>>`. It fits each context that has the
   * vars that it reads, and the context gets the vars that it sets. A middleware without
   * `ContextEnv` reads no vars and sets all its `Variables`. The `Bindings` of the
   * middleware are added to the bindings of the context, without a check. The second type
   * parameter has no default, so an explicit type argument cannot select this signature.
   */
  <THandler extends MiddlewareHandler<any, any, any>, _NoExplicitTypeArgs>(
    handler: THandler & CheckMiddlewareFits<THandler, TVars>,
  ): RouteContext<TPath, TVars & HandlerSets<THandler>, TBindings & HandlerBindings<THandler>>;
}

export interface RouteContext<
  TPath extends string,
  TVars extends object,
  TBindings extends object = {},
> {
  path: TPath;
  vars: TVars;
  /** A phantom value of the Cloudflare `Bindings` (`c.env`). It is never read at runtime. */
  bindings: TBindings;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars, TBindings>;
  /**
   * Loads a value from a path param and adds it to the context as the var `key`. Returns a
   * new context, as `.middleware()` does. The new middleware gives the value of `param` to
   * `load`. When `load` gives `null` or `undefined`, the middleware returns `c.notFound()`.
   * Otherwise it sets `c.var[key]` and calls `next`. An error from `load` goes to
   * `app.onError`. `key` must be one string literal and a new var: a `string` key or a union
   * key is an error. `param` must be a required param of the path. When the param is missing
   * from the request, the middleware returns `c.notFound()` and does not call `load`. The
   * middleware name is `bind:<key>`. `showRoutes` shows it only with `{ verbose: true }`.
   *
   * Limits:
   * - An annotation on `c` with other vars, or an explicit third type argument, lets `load`
   *   read vars that the context does not have. It does not skip the check of `key`.
   * - A context with a widened `string` path cannot call `.bind()`, because
   *   `BindParam<string>` is `never`.
   * - Hono matches a mounted router by path prefix. A child mounted after the bound router
   *   under the same param segment (`/:organizationId/settings` after `/:organizationId`)
   *   is not checked, and its requests also run `load`. Mount such a sibling first. A param
   *   child mounted before a literal sibling (`/:id` before `/new`) is a `TypeError` at
   *   mount.
   *
   * `_TLoaderVars` is internal: do not pass it. Its default is `TVars`. A type parameter keeps
   * a context assignable to a context with fewer vars: a check of two generic signatures
   * matches it to the type parameter of the other signature.
   */
  bind: <TKey extends string, TValue, _TLoaderVars extends TVars = TVars>(
    key: BindKey<TKey, _TLoaderVars>,
    param: BindParam<TPath>,
    load: BindLoader<_TLoaderVars, TValue, TBindings>,
  ) => RouteContext<TPath, TVars & { [K in TKey]: NonNullable<Awaited<TValue>> }, TBindings>;
  /**
   * Internal: the path relative to the parent, which `makeRouter` uses as the router's
   * base path so that mounting under the parent does not prefix the parent path twice.
   * Equals `path` for root contexts and curried children; for a value-form
   * `defineChildContext(parent, segment)` child, `path` is the full path and this is
   * `segment`. When absent, `makeRouter` uses `path`.
   */
  readonly segment?: string;
}

export interface DefineRootContextFn {
  /**
   * The vars and the bindings come from the type arguments, or from the `Variables` and the
   * `Bindings` of the middlewares when they all declare the same ones. Without
   * `middlewares`, the vars and the bindings are `{}`. Must stay first, so that TypeScript
   * tries it before the fold signature. A call with one, two or three explicit type
   * arguments always resolves here. A middleware typed `MiddlewareHandler<{ Variables: any }>`
   * in the array makes the vars `any`, because this signature then matches with
   * `TVars = any`. With a `TBindings` type argument, each typed middleware in the array must
   * declare these `Bindings`: Hono's `Context` is invariant in its `Env`, so a middleware
   * typed only with `Variables` does not fit. Add such a middleware with `.middleware()`.
   */
  <TPath extends string, TVars extends object = {}, TBindings extends object = {}>(
    path: TPath,
    middlewares?: MiddlewareHandler<RouterEnv<TVars, TBindings>>[],
  ): RouteContext<TPath, TVars, TBindings>;
  /**
   * Fold: the vars are the intersection of the `Variables` of each middleware, and the
   * bindings are the intersection of their `Bindings`. Thus typed middlewares with different
   * vars can share the array. TypeScript can also select this signature for an array of one
   * kind (plain handlers, untyped `createMiddleware`, a `MiddlewareHandler[]` variable, a
   * spread); the vars are then the same as from the first signature. The third and fourth
   * type parameters are not used and have no default, so one, two or three explicit type
   * arguments cannot select this signature. Four explicit type arguments
   * (`<'/x', [typeof a, typeof b], unknown, unknown>`) select it; that compiles but has no
   * use. `CheckRootArray` rejects conflicting var types and a non-tuple array of mixed
   * middlewares; a readonly tuple (`as const`) is accepted.
   *
   * An inline arrow in an array with typed middlewares that declare different vars does not
   * get a contextual type on TypeScript 7 (`c` is `Context<any>`), and TypeScript 5.9 reports
   * an error in it. Write such a handler with `createMiddleware`, or add it with
   * `.middleware()`.
   */
  <
    TPath extends string,
    TMws extends readonly MiddlewareHandler[],
    _NoExplicitTypeArgs,
    _NoExplicitTypeArgs2,
  >(
    path: TPath,
    middlewares?: readonly [...TMws] & CheckRootArray<TMws>,
  ): RouteContext<TPath, FoldVars<TMws>, FoldBindings<TMws>>;
}

/**
 * Anything carrying a path literal and a vars phantom: a base or an extended context. A
 * context with a `bindings` phantom also gives its bindings to its children.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ParentContext = { path: string; vars: object; bindings?: object };

/**
 * The Hono `Env` of a middleware that runs on `TContext` and sets `TNewVars`. Pass it to
 * `createMiddleware` from `hono/factory` to build a middleware outside the context chain:
 * `createMiddleware<ContextEnv<typeof ctx, { session: Session }>>(...)`. The middleware then
 * reads the vars of the context and sets the new vars, all typed. When the context has
 * bindings, the `Env` also has them as `Bindings`, so `c.env` is typed.
 *
 * The type-only {@link READS} key records the vars of `TContext`, which the middleware
 * reads. The type-only {@link SETS} key records `TNewVars`, which the middleware sets. Thus
 * `.middleware()` accepts the middleware on `TContext` and on each context that has more
 * vars (a child of a `.middleware()` descendant), and adds only `TNewVars`. A context that
 * does not have the read vars gives an error. A `TNewVars` key that `TContext` also has is a
 * redeclaration. Do not pass a type argument to `.middleware()` for this middleware: the
 * explicit form does not accept it.
 */
export type ContextEnv<TContext extends ParentContext, TNewVars extends object = {}> = {
  [
    K in keyof FullContextEnv<TContext, TNewVars> as K extends 'Bindings'
      ? [keyof ContextBindings<TContext>] extends [never]
        ? never
        : K
      : K
  ]: FullContextEnv<TContext, TNewVars>[K];
};

/**
 * {@link ContextEnv} with a `Bindings` key in all cases. `ContextEnv` maps over it and drops
 * the key when the bindings are empty. A mapped type keeps the `ContextEnv` alias in the
 * declarations of a consumer. A conditional type gives an object type without the alias,
 * and the declaration of the consumer then cannot name `READS` and `SETS` (TS4023).
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type FullContextEnv<TContext extends ParentContext, TNewVars extends object> = {
  Bindings: ContextBindings<TContext>;
  Variables: TContext['vars'] & TNewVars;
  readonly [READS]: TContext['vars'];
  readonly [SETS]: TNewVars;
};

/**
 * The function that the curried `defineChildContext<typeof parent>()` returns. The child
 * has the vars and the bindings of the parent.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ChildRouteFn<TParentContext extends ParentContext> = <TPath extends string>(
  path: TPath,
) => RouteContext<
  ChildPath<TParentContext['path'], TPath>,
  TParentContext['vars'],
  ContextBindings<TParentContext>
>;

/**
 * Internal: resolves to `TFn` for any `TParentContext`, but stays a deferred conditional type
 * in a generic signature. The curried `defineChildContext` overload returns its function through
 * this wrapper so that the signature is not a "generic function returning a function" to
 * TypeScript. When an overload set has such a signature, TypeScript skips a call to it
 * nested inline in another generic call during that call's first inference pass, so the
 * outer type parameter falls back to its constraint (`string`). That breaks
 * `bind(defineChildContext(parent, '/x'), 'param')`. Do not inline it into a plain function type.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type DeferredChildContextFn<TParentContext, TFn> = [TParentContext] extends [unknown]
  ? TFn
  : never;

export interface DefineChildContextFn {
  /**
   * Value form: infers the parent's path, vars and bindings from the `parent` value. The
   * child's runtime `path` is `parent.path` joined with `path` by `/` (the full path when
   * every ancestor is a root or a value-form child; a parent `'/'` adds no extra slash).
   * Needs the parent value at module load, so use the curried form when the parent module
   * imports the child's router (a circular import).
   */
  <
    TPath extends string,
    TParentPath extends string,
    TParentVars extends object,
    TParentBindings extends object = {},
  >(
    parent: { path: TParentPath; vars: TParentVars; bindings?: TParentBindings },
    path: TPath,
  ): RouteContext<ChildPath<TParentPath, TPath>, TParentVars, TParentBindings>;
  /**
   * Curried form: the parent is passed as a type only, so the child module needs no
   * runtime import of the parent (safe in a circular import). The child's runtime
   * `path` is its own segment.
   */
  <TParentContext extends ParentContext>(): DeferredChildContextFn<
    TParentContext,
    ChildRouteFn<TParentContext>
  >;
}
