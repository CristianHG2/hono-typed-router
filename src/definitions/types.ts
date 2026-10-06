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
