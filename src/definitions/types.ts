import type { MiddlewareHandler } from 'hono';
import type { BindKey, BindLoader, BindParam } from './bind';
import type { ChildPath } from './path';
import type { CheckRootArray, FoldVars } from './root-array';

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

/**
 * Type-only key that {@link ContextEnv} puts on an `Env`: the vars that the middleware reads
 * from its context. `.middleware()` and the root array use it to tell the vars that a
 * middleware reads from the vars that it sets. No runtime value has this key.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export declare const READS: unique symbol;

/** The `Env` of a middleware, or `never` if `THandler` is not a middleware. */
type HandlerEnv<THandler> = THandler extends MiddlewareHandler<infer E, any, any> ? E : never;

/** The `Variables` of an `Env`. An untyped `Env` (`any`, or `any` variables) gives `{}`. */
type EnvVars<E> =
  IsAny<E> extends true
    ? {}
    : E extends { Variables: infer V extends object }
      ? IsAny<V> extends true
        ? {}
        : V
      : {};

/** The vars that an `Env` built with `ContextEnv` reads. Any other `Env` gives `{}`. */
type EnvReads<E> =
  IsAny<E> extends true ? {} : E extends { readonly [READS]: infer R extends object } ? R : {};

/**
 * Type-only key that {@link ContextEnv} puts on an `Env`: the vars that the middleware sets.
 * `.middleware()` and the root array read the set vars from this key, not from
 * `Omit<Variables, keyof reads>`. An `Omit` makes each context in a chain of `ContextEnv`
 * middlewares contain the `Omit` of the previous context, and the check time grows
 * exponentially with the chain length. No runtime value has this key.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export declare const SETS: unique symbol;

/**
 * The vars that an `Env` sets: the {@link SETS} key of a `ContextEnv` `Env`. Any other `Env`
 * sets all its `Variables`.
 */
type EnvSets<E> =
  IsAny<E> extends true
    ? {}
    : E extends { readonly [SETS]: infer N extends object }
      ? N
      : EnvVars<E>;

/**
 * The vars that a middleware reads from its context (`{}` if not built with `ContextEnv`).
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerReads<THandler> = EnvReads<HandlerEnv<THandler>>;

/**
 * The vars that a middleware sets: its `Variables` without the vars that it reads.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerSets<THandler> = EnvSets<HandlerEnv<THandler>>;

/**
 * `unknown` when a typed middleware with `Env` `E` fits a context with vars `TVars`, else a
 * message. It fits when the context has each var that the middleware reads, and the
 * middleware sets no var that the context has.
 */
type CheckEnvFits<E, TVars> = [Exclude<keyof EnvReads<E>, keyof TVars>] extends [never]
  ? [Extract<keyof EnvSets<E>, keyof TVars>] extends [never]
    ? unknown
    : `Cannot redeclare existing var: ${Extract<keyof EnvSets<E>, keyof TVars> & string}`
  : `This middleware reads vars that the context does not have: ${Exclude<keyof EnvReads<E>, keyof TVars> & string}`;

/**
 * {@link CheckEnvFits} for a middleware.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type CheckMiddlewareFits<THandler, TVars> = CheckEnvFits<HandlerEnv<THandler>, TVars>;

export interface MiddlewareFactory<TPath extends string, TVars extends object> {
  /**
   * An inline handler: `c` has the vars of the context plus `TNewVars`. Must stay first, so
   * that TypeScript tries it first and an error in the handler body stays in the body. An
   * explicit type argument always selects this signature.
   */
  <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
  ): RouteContext<TPath, TVars & TNewVars>;
  /**
   * A reusable middleware with its own `Env`: `createMiddleware<{ Variables: NewVars }>` or
   * `createMiddleware<ContextEnv<typeof ctx, NewVars>>`. It fits each context that has the
   * vars that it reads, and the context gets the vars that it sets. A middleware without
   * `ContextEnv` reads no vars and sets all its `Variables`. `Bindings` are not added to the
   * context. The second type parameter has no default, so an explicit type argument cannot
   * select this signature.
   */
  <THandler extends MiddlewareHandler<any, any, any>, _NoExplicitTypeArgs>(
    handler: THandler & CheckMiddlewareFits<THandler, TVars>,
  ): RouteContext<TPath, TVars & HandlerSets<THandler>>;
}

export interface RouteContext<TPath extends string, TVars extends object> {
  path: TPath;
  vars: TVars;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars>;
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
    load: BindLoader<_TLoaderVars, TValue>,
  ) => RouteContext<TPath, TVars & { [K in TKey]: NonNullable<Awaited<TValue>> }>;
  /**
   * Internal: the path relative to the parent, which `makeRouter` uses as the router's
   * base path so that mounting under the parent does not prefix the parent path twice.
   * Equals `path` for root contexts and curried children; for a value-form
   * `defineChildContext(parent, segment)` child, `path` is the full path and this is
   * `segment`. When absent, `makeRouter` uses `path`.
   */
  readonly segment?: string;
}

/** `true` if `T` is `any`. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * The `Variables` that a middleware declares. An untyped handler (`Env` or `any`
 * variables) gives `{}`.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type HandlerVars<THandler> = EnvVars<HandlerEnv<THandler>>;

export interface DefineRootContextFn {
  /**
   * The vars come from the type argument, or from the `Variables` of the middlewares when
   * they all declare the same vars. Without `middlewares`, the vars are `{}`. Must stay first, so that TypeScript tries it before the
   * fold signature. A call with one or two explicit type arguments always resolves here. A
   * middleware typed `MiddlewareHandler<{ Variables: any }>` in the array makes the vars
   * `any`, because this signature then matches with `TVars = any`.
   */
  <TPath extends string, TVars extends object = {}>(
    path: TPath,
    middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
  ): RouteContext<TPath, TVars>;
  /**
   * Fold: the vars are the intersection of the `Variables` of each middleware, so typed
   * middlewares with different vars can share the array. TypeScript can also select this
   * signature for an array of one kind (plain handlers, untyped `createMiddleware`, a
   * `MiddlewareHandler[]` variable, a spread); the vars are then the same as from the first
   * signature. The third type parameter is not used and has no default, so one or two
   * explicit type arguments cannot select this signature. Three explicit type arguments
   * (`<'/x', [typeof a, typeof b], unknown>`) select it; that compiles but has no use.
   * `CheckRootArray` rejects conflicting var types and a non-tuple array of mixed
   * middlewares; a readonly tuple (`as const`) is accepted.
   *
   * An inline arrow in an array with typed middlewares that declare different vars does not
   * get a contextual type on TypeScript 7 (`c` is `Context<any>`), and TypeScript 5.9 reports
   * an error in it. Write such a handler with `createMiddleware`, or add it with
   * `.middleware()`.
   */
  <TPath extends string, TMws extends readonly MiddlewareHandler[], _NoExplicitTypeArgs>(
    path: TPath,
    middlewares?: readonly [...TMws] & CheckRootArray<TMws>,
  ): RouteContext<TPath, FoldVars<TMws>>;
}

/**
 * Anything carrying a path literal and a vars phantom: a base or an extended context.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ParentContext = { path: string; vars: object };

/**
 * The Hono `Env` of a middleware that runs on `TContext` and sets `TNewVars`. Pass it to
 * `createMiddleware` from `hono/factory` to build a middleware outside the context chain:
 * `createMiddleware<ContextEnv<typeof ctx, { session: Session }>>(...)`. The middleware then
 * reads the vars of the context and sets the new vars, all typed.
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
  Variables: TContext['vars'] & TNewVars;
  readonly [READS]: TContext['vars'];
  readonly [SETS]: TNewVars;
};

/**
 * The function that the curried `defineChildContext<typeof parent>()` returns.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ChildRouteFn<TParentContext extends ParentContext> = <TPath extends string>(
  path: TPath,
) => RouteContext<ChildPath<TParentContext['path'], TPath>, TParentContext['vars']>;

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
   * Value form: infers the parent's path and vars from the `parent` value. The child's
   * runtime `path` is `parent.path` joined with `path` by `/` (the full path when every ancestor is a root
   * or a value-form child; a parent `'/'` adds no extra slash). Needs the parent value at
   * module load, so use the curried form when the parent module imports the child's
   * router (a circular import).
   */
  <TPath extends string, TParentPath extends string, TParentVars extends object>(
    parent: { path: TParentPath; vars: TParentVars },
    path: TPath,
  ): RouteContext<ChildPath<TParentPath, TPath>, TParentVars>;
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
