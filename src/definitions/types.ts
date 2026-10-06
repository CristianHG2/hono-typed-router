import type { MiddlewareHandler } from 'hono';
import type { BindKey, BindLoader, BindParam, CheckBindLoader } from './bind';
import type { ChildPath } from './path';
import type {
  CheckMiddlewareFits,
  ContextBindings,
  HandlerBindings,
  HandlerSets,
  READS,
  RedeclareMessage,
  RouterEnv,
  SETS,
} from './env';
import type { CheckRootArray, FoldBindings, FoldVars } from './root-array';

export type { HandlerReads, HandlerSets, HandlerVars, READS, SETS } from './env';

/**
 * The constraint of the type argument of `.middleware<TNewVars>()`. A key that `TOld` has
 * maps to an error string. Thus a redeclared var fails on the type argument, not on the handler.
 *
 * @internal Exported for declaration emit.
 */
export type NoRedeclare<TNew, TOld> = {
  [K in keyof TNew]: K extends keyof TOld ? RedeclareMessage<K & string> : TNew[K];
};

export interface MiddlewareFactory<
  TPath extends string,
  TVars extends object,
  TBindings extends object = {},
> {
  /**
   * An inline handler. `c` has the vars of the context plus `TNewVars`, and `c.env` has the
   * bindings of the context. This signature must stay first. TypeScript then tries it first,
   * and an error in the handler body stays in the body. An explicit type argument always
   * selects this signature.
   */
  <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<RouterEnv<TVars & TNewVars, TBindings>, TPath>,
  ): RouteContext<TPath, TVars & TNewVars, TBindings>;
  /**
   * A middleware typed only with `Variables`, on a context with bindings. Hono's `Context<E>`
   * is invariant: it accepts only an `Env` with the same `Bindings` and `Variables`. Thus this
   * middleware does not fit the first signature. On a context without bindings, the first
   * signature matches.
   */
  <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
  ): RouteContext<TPath, TVars & TNewVars, TBindings>;
  /**
   * A reusable middleware with its own `Env`, for example
   * `createMiddleware<ContextEnv<typeof ctx, NewVars>>`. It fits each context that has the vars
   * that it reads. The context gets the vars that it sets. A middleware without `ContextEnv`
   * reads no vars and sets all its `Variables`. The `Bindings` of the middleware are added to
   * the context without a check. `_NoExplicitTypeArgs` has no default, so an explicit type
   * argument cannot select this signature.
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
  /** A phantom of the Cloudflare `Bindings` (`c.env`). Runtime code never reads it. */
  bindings: TBindings;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars, TBindings>;
  /**
   * Loads a value from a path param and adds it to the context as the var `key`. Returns a
   * new context, as `.middleware()` does. The middleware gives the value of `param` to `load`.
   * If the param is missing, or `load` gives `null` or `undefined`, the middleware returns
   * `c.notFound()`. An error from `load` goes to `app.onError`. `key` must be one new string
   * literal. `param` must be a required param of the path. A loader that can return no value
   * is an error. The middleware name is `bind:<key>`.
   *
   * Limits:
   * - An annotation on `c`, or an explicit third type argument, lets `load` read vars that
   *   the context does not have.
   * - A context with a `string` path cannot call `.bind()`.
   * - Hono matches a mounted router by path prefix. A sibling mounted after the bound router
   *   under the same param segment also runs `load`. Mount such a sibling first.
   * - A loader with a generic return type is accepted. The loader check does not run through
   *   a generic wrapper. It unwraps one `Promise`, not a nested `Promise` or a thenable.
   *
   * `_TLoaderVars` is internal. Do not pass it. TypeScript matches the type parameters of two
   * generic signatures, so a context stays assignable to a context with fewer vars.
   */
  bind: <TKey extends string, TValue, _TLoaderVars extends TVars = TVars>(
    key: BindKey<TKey, _TLoaderVars>,
    param: BindParam<TPath>,
    load: BindLoader<_TLoaderVars, TValue, TBindings> & CheckBindLoader<TValue>,
  ) => RouteContext<TPath, TVars & { [K in TKey]: NonNullable<Awaited<TValue>> }, TBindings>;
  /**
   * Internal: the path relative to the parent. `makeRouter` uses it as the base path of the
   * router, so that a mount does not add the parent path twice. A value-form child has the
   * full `path` and its own `segment`. Without it, `makeRouter` uses `path`.
   */
  readonly segment?: string;
}

export interface DefineRootContextFn {
  /**
   * The vars and the bindings come from the type arguments, or from the middlewares when they
   * all declare the same `Variables` and `Bindings`. This signature must stay first, so that
   * TypeScript tries it before the fold signature. One to three explicit type arguments
   * select it. A middleware typed `MiddlewareHandler<{ Variables: any }>` makes the vars `any`.
   * With a `TBindings` type argument, each typed middleware must declare these `Bindings` (see
   * `MiddlewareFactory`). Add a middleware typed only with `Variables` with `.middleware()`.
   */
  <TPath extends string, TVars extends object = {}, TBindings extends object = {}>(
    path: TPath,
    middlewares?: MiddlewareHandler<RouterEnv<TVars, TBindings>>[],
  ): RouteContext<TPath, TVars, TBindings>;
  /**
   * Fold: the vars are the intersection of the `Variables` of the middlewares, and the
   * bindings are the intersection of their `Bindings`. Thus typed middlewares with different
   * vars can share the array. The two `_NoExplicitTypeArgs` parameters have no default, so one
   * to three explicit type arguments cannot select this signature. `CheckRootArray` rejects
   * conflicting var types and a non-tuple array of mixed middlewares.
   *
   * Limit: in an array of typed middlewares with different vars, an inline arrow gets no
   * contextual type. TypeScript 7 types `c` as `Context<any>`, and TypeScript 5.9 reports an
   * error. Write such a handler with `createMiddleware`, or add it with `.middleware()`.
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
 * A base or an extended context: a path literal and a vars phantom. A context with a
 * `bindings` phantom gives its bindings to its children.
 *
 * @internal Exported for declaration emit.
 */
export type ParentContext = { path: string; vars: object; bindings?: object };

/**
 * The Hono `Env` of a middleware that runs on `TContext` and sets `TNewVars`. Pass it to
 * `createMiddleware` from `hono/factory`:
 * `createMiddleware<ContextEnv<typeof ctx, { session: Session }>>(...)`. The middleware reads
 * the vars of the context and sets the new vars. If the context has bindings, the `Env` has
 * them as `Bindings`.
 *
 * `.middleware()` accepts the middleware on `TContext` and on each context with more vars,
 * and adds only `TNewVars` (see {@link READS} and {@link SETS}). A context without the read
 * vars is an error. A `TNewVars` key that `TContext` has is a redeclaration. Do not pass a
 * type argument to `.middleware()` for this middleware.
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
 * an empty `Bindings`. A mapped type keeps the `ContextEnv` alias in consumer declarations. A
 * conditional type loses the alias, and the consumer then cannot name `READS` and `SETS`
 * (TS4023).
 *
 * @internal Exported for declaration emit.
 */
export type FullContextEnv<TContext extends ParentContext, TNewVars extends object> = {
  Bindings: ContextBindings<TContext>;
  Variables: TContext['vars'] & TNewVars;
  readonly [READS]: TContext['vars'];
  readonly [SETS]: TNewVars;
};

/**
 * The function that the curried `defineChildContext<typeof parent>()` returns.
 *
 * @internal Exported for declaration emit.
 */
export type ChildRouteFn<TParentContext extends ParentContext> = <TPath extends string>(
  path: TPath,
) => RouteContext<
  ChildPath<TParentContext['path'], TPath>,
  TParentContext['vars'],
  ContextBindings<TParentContext>
>;

/**
 * Resolves to `TFn`, but stays a deferred conditional type in a generic signature. Thus the
 * curried `defineChildContext` is not a "generic function that returns a function". In the
 * first inference pass of an outer generic call, TypeScript skips such an overload set. The
 * outer type parameter then falls back to `string`, and
 * `bind(defineChildContext(parent, '/x'), 'param')` breaks. Do not inline it into a plain
 * function type.
 *
 * @internal Exported for declaration emit.
 */
export type DeferredChildContextFn<TParentContext, TFn> = [TParentContext] extends [unknown]
  ? TFn
  : never;

export interface DefineChildContextFn {
  /**
   * Value form: infers the path, vars and bindings of the parent from `parent`. The runtime
   * `path` is `parent.path` joined with `path`. A parent `'/'` adds no slash. The parent value
   * must exist at module load. If the parent module imports the router of the child (a
   * circular import), use the curried form.
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
   * Curried form: the parent is a type only, so the child module does not import the parent
   * at runtime. The runtime `path` of the child is its own segment.
   */
  <TParentContext extends ParentContext>(): DeferredChildContextFn<
    TParentContext,
    ChildRouteFn<TParentContext>
  >;
}
