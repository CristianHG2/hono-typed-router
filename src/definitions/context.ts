import type { MiddlewareHandler } from 'hono';
import type { BindKey, BindLoader, BindParam, CheckBindLoader } from './bind';
import type { ChildPath } from './path';
import type {
  CheckMiddlewareFits,
  ContextBindings,
  HandlerBindings,
  HandlerSets,
  RedeclareMessage,
  RouterEnv,
} from './env';

/**
 * Maps a key that `TOld` has to an error string, so that a redeclared var fails on the type
 * argument and not in the handler.
 *
 * @internal
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
   * An inline handler. Keep this signature first: TypeScript tries it first, so an error in the
   * handler stays in the handler body. An explicit type argument always selects it.
   */
  <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<RouterEnv<TVars & TNewVars, TBindings>, TPath>,
  ): RouteContext<TPath, TVars & TNewVars, TBindings>;
  /**
   * A middleware typed only with `Variables`, on a context with bindings. Hono's `Context<E>` is
   * invariant in `E`, so this middleware does not fit the first signature.
   */
  <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
  ): RouteContext<TPath, TVars & TNewVars, TBindings>;
  /**
   * A reusable middleware with its own `Env`. The context gets the vars that it sets, and its
   * `Bindings` without a check. `_NoExplicitTypeArgs` has no default, so an explicit type
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
   * Loads a value from the path param `param` and adds it to the context as the var `key`. If
   * the param is missing, or `load` returns `null` or `undefined`, the middleware returns
   * `c.notFound()`. `docs/api.md` lists the limits.
   *
   * Do not pass `_TLoaderVars`. TypeScript matches the type parameters of two generic
   * signatures, so with it a context stays assignable to a context with fewer vars.
   */
  bind: <TKey extends string, TValue, _TLoaderVars extends TVars = TVars>(
    key: BindKey<TKey, _TLoaderVars>,
    param: BindParam<TPath>,
    load: BindLoader<_TLoaderVars, TValue, TBindings> & CheckBindLoader<TValue>,
  ) => RouteContext<TPath, TVars & { [K in TKey]: NonNullable<Awaited<TValue>> }, TBindings>;
  /**
   * Internal: the path relative to the parent. `makeRouter` uses it as the base path, so that
   * a mount does not add the parent path twice.
   */
  readonly segment?: string;
}

/** @internal */
export type ParentContext = { path: string; vars: object; bindings?: object };

/** @internal */
export type ChildRouteFn<TParentContext extends ParentContext> = <TPath extends string>(
  path: TPath,
) => RouteContext<
  ChildPath<TParentContext['path'], TPath>,
  TParentContext['vars'],
  ContextBindings<TParentContext>
>;

/**
 * Resolves to `TFn`, but stays a deferred conditional type in a generic signature. In the first
 * inference pass of an outer generic call, TypeScript skips an overload set that has a generic
 * function that returns a function. The outer type parameter then falls back to `string`, and
 * `bind(defineChildContext(parent, '/x'), 'param')` breaks. Do not inline it.
 *
 * @internal
 */
export type DeferredChildContextFn<TParentContext, TFn> = [TParentContext] extends [unknown]
  ? TFn
  : never;
