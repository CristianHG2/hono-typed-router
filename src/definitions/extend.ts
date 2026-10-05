import type { MiddlewareHandler } from 'hono';
import type { BindKey, BindLoader, BindParam, CheckBindLoader } from './bind';
import {
  defineChildContext as defineChildContextBase,
  defineRootContext as defineRootContextBase,
} from './lib';
import type { ChildPath } from './path';
import type { CheckRootArray, FoldVars } from './root-array';
import type { ContextBindings, HandlerSets } from './env';
import type {
  BindingsSlot,
  CheckExtendedMiddlewareFits,
  CheckNoBindings,
  CheckNoRootBindings,
} from './extend-bindings';
import type { DeferredChildContextFn, NoRedeclare, ParentContext, RouteContext } from './types';

/**
 * A higher-kinded slot that passes a context interface with two type parameters to
 * {@link extendRouteContext}. Map the `path` and `vars` slots to your context interface:
 *
 * ```ts
 * interface MyContextKind extends RouteContextKind {
 *   type: MyContext<this['path'] & string, this['vars'] & object>;
 * }
 * ```
 */
export interface RouteContextKind {
  readonly path: string;
  readonly vars: object;
  readonly type: unknown;
}

/**
 * The context type of a {@link RouteContextKind} at a given `path` and `vars`. The `type` of
 * the kind is an interface, which TypeScript resolves lazily. Thus a chain of methods that
 * return this type does not hit the "excessively deep" instantiation error.
 */
export type ReaugmentContext<
  K extends RouteContextKind,
  TPath extends string,
  TVars extends object,
> = (K & { readonly path: TPath; readonly vars: TVars })['type'];

/**
 * The base members of an extended context interface. Extend it in your context interface
 * and add your builders. Each builder returns `ReaugmentContext<YourKind, TPath, TVars & NewVars>`:
 *
 * ```ts
 * interface MyContext<TPath extends string, TVars extends object>
 *   extends RouteContextBase<MyContextKind, TPath, TVars> {
 *   bindRepository: <TKey extends string, TRepo>(
 *     key: TKey extends keyof TVars ? `Cannot redeclare existing var: "${TKey}"` : TKey,
 *     param: ParamKeys<TPath>,
 *     repository: () => TRepo,
 *   ) => ReaugmentContext<MyContextKind, TPath, TVars & { [K in TKey]: Relations<TRepo> }>;
 * }
 * ```
 *
 * This interface declares `middleware` and `bind`. Do not declare a builder with one of
 * these names.
 */
export interface RouteContextBase<
  K extends RouteContextKind,
  TPath extends string,
  TVars extends object,
> extends Omit<RouteContext<TPath, TVars>, 'middleware' | 'bind'> {
  middleware: {
    /** An inline handler. Must stay first (see `MiddlewareFactory`). */
    <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
      handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
    ): ReaugmentContext<K, TPath, TVars & TNewVars>;
    /** A reusable typed middleware (see `MiddlewareFactory`). */
    <THandler extends MiddlewareHandler<any, any, any>, _NoExplicitTypeArgs>(
      handler: THandler & CheckExtendedMiddlewareFits<THandler, TVars>,
    ): ReaugmentContext<K, TPath, TVars & HandlerSets<THandler>>;
  };
  /** See `RouteContext.bind`. The returned context keeps the builders of `K`. */
  bind: <TKey extends string, TValue, _TLoaderVars extends TVars = TVars>(
    key: BindKey<TKey, _TLoaderVars>,
    param: BindParam<TPath>,
    load: BindLoader<_TLoaderVars, TValue> & CheckBindLoader<TValue>,
  ) => ReaugmentContext<K, TPath, TVars & { [Key in TKey]: NonNullable<Awaited<TValue>> }>;
}

type BaseKeys = keyof RouteContextBase<RouteContextKind, string, object>;

/**
 * The names of the builders that `K` adds to {@link RouteContextBase}.
 *
 * @internal Exported for declaration emit.
 */
export type ExtensionNames<K extends RouteContextKind> = Exclude<
  keyof ReaugmentContext<K, string, object>,
  BaseKeys
>;

/**
 * The runtime builders of the methods of `K`. Each builder gets the extended context and
 * returns the method. The method parameters come from the context interface at a `string`
 * path and `object` vars. Callers see the exact signature of the context interface.
 *
 * @internal Exported for declaration emit.
 */
export type ExtensionBuilders<K extends RouteContextKind> = {
  [Name in ExtensionNames<K> & string]: (
    ctx: ReaugmentContext<K, string, object>,
  ) => (
    ...args: ParamsOf<ReaugmentContext<K, string, object>[Name]>
  ) => ReaugmentContext<K, string, object>;
};

// Not `Parameters<>`: TypeScript cannot prove that an indexed access into the kind meets its
// `(...args: any) => any` constraint (TS2344).
type ParamsOf<T> = T extends (...args: infer P) => unknown ? P : never;

/**
 * The `define*` functions that {@link extendRouteContext} returns.
 *
 * @internal Exported for declaration emit.
 */
export interface ExtendRouteContextResult<K extends RouteContextKind> {
  defineRootContext: {
    /** Must stay first (see `DefineRootContextFn`). */
    <TPath extends string, TVars extends object = {}>(
      path: TPath,
      middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
    ): ReaugmentContext<K, TPath, TVars>;
    /**
     * Fold (see `DefineRootContextFn`).
     *
     * `_TVars` is internal. Do not pass it. Four explicit type arguments set the vars without
     * a check. A kind evaluates `this['vars'] & object`.
     * TypeScript simplifies that to `_TVars` for a type parameter. For a concrete `{}`, it
     * gives `object`, so a direct `FoldVars<TMws>` gives the wrong vars.
     */
    <
      TPath extends string,
      TMws extends readonly MiddlewareHandler[],
      _NoExplicitTypeArgs,
      _TVars extends object = FoldVars<TMws>,
    >(
      path: TPath,
      middlewares?: readonly [...TMws] & CheckRootArray<TMws> & CheckNoRootBindings<TMws>,
    ): ReaugmentContext<K, TPath, _TVars>;
  };
  defineChildContext: {
    /** Value form (see `DefineChildContextFn`). */
    <
      TPath extends string,
      TParentPath extends string,
      TParentVars extends object,
      TParentBindings extends BindingsSlot<TParentBindings> = {},
    >(
      parent: { path: TParentPath; vars: TParentVars; bindings?: TParentBindings },
      path: TPath,
    ): ReaugmentContext<K, ChildPath<TParentPath, TPath>, TParentVars>;
    /** Curried form (see `DefineChildContextFn`). */
    <
      TParentContext extends { path: string; vars: object } & CheckNoBindings<
        ContextBindings<TParentContext>
      >,
    >(): DeferredChildContextFn<
      TParentContext,
      <TPath extends string>(
        path: TPath,
      ) => ReaugmentContext<K, ChildPath<TParentContext['path'], TPath>, TParentContext['vars']>
    >;
  };
  /** @deprecated Use defineRootContext. Removed in 2.0. */
  defineRootRoute: ExtendRouteContextResult<K>['defineRootContext'];
  /** @deprecated Use defineChildContext. Removed in 2.0. */
  defineChildRoute: ExtendRouteContextResult<K>['defineChildContext'];
}

/**
 * Adds typed builder methods to the contexts of `defineRootContext` and `defineChildContext`.
 * Each method gets the path and the vars of the context. The contexts that `.middleware()`,
 * `.bind()` and your builders return keep the methods.
 *
 * An extended context does not carry Cloudflare `Bindings`. A parent with bindings, and a
 * middleware that declares `Bindings`, are compile errors.
 *
 * Declare the context as an interface that extends {@link RouteContextBase}, and a
 * {@link RouteContextKind} for it. Pass the kind as the type argument and the runtime
 * builders as the argument:
 *
 * ```ts
 * interface Ctx<P extends string, V extends object> extends RouteContextBase<CtxK, P, V> {
 *   bindValue: <K extends string, T>(key: ..., param: ParamKeys<P>, produce: () => T)
 *     => ReaugmentContext<CtxK, P, V & { [Key in K]: T }>;
 * }
 * interface CtxK extends RouteContextKind { type: Ctx<this['path'] & string, this['vars'] & object>; }
 *
 * const { defineRootContext, defineChildContext } = extendRouteContext<CtxK>({
 *   bindValue: (ctx) => (key, param, produce) =>
 *     ctx.middleware(async (c, next) => { c.set(key, produce(c.req.param(param))); await next(); }),
 * });
 * ```
 */
export function extendRouteContext<K extends RouteContextKind>(
  builders: ExtensionBuilders<K>,
): ExtendRouteContextResult<K> {
  const names = Object.keys(builders);

  const augment = (base: RouteContext<string, object>): RouteContext<string, object> => {
    const augmented: Record<string, unknown> = {
      ...base,
      // SAFETY: `RouteContext.middleware` is generic only in its types. At runtime it takes one
      // handler and returns a new `RouteContext`.
      middleware: (handler: MiddlewareHandler) =>
        augment(
          (base.middleware as (h: MiddlewareHandler) => RouteContext<string, object>)(handler),
        ),
      // SAFETY: `RouteContext.bind` is generic only in its types. At runtime it takes a key, a
      // param and a loader, and returns a new `RouteContext`.
      bind: (key: string, param: string, load: BindLoader<object, unknown>) =>
        augment(
          (
            base.bind as (
              k: string,
              p: string,
              l: BindLoader<object, unknown>,
            ) => RouteContext<string, object>
          )(key, param, load),
        ),
    };

    for (const name of names) {
      // SAFETY: `name` comes from `Object.keys(builders)`, and each builder takes the context.
      augmented[name] = (builders as Record<string, (ctx: unknown) => unknown>)[name](augmented);
    }

    // SAFETY: `augmented` is a copy of `base` with new `middleware` and `bind`, plus the builders.
    return augmented as unknown as RouteContext<string, object>;
  };

  // SAFETY: both functions return extended contexts. `ExtendRouteContextResult<K>` types them
  // through the kind `K`, which the runtime signatures cannot express.
  const defineRootContext = ((path: string, middlewares: MiddlewareHandler[] = []) =>
    augment(defineRootContextBase(path, middlewares))) as never;

  // SAFETY: the same as `defineRootContext`, for both forms of the child.
  const defineChildContext = ((...args: [] | [ParentContext, string]) =>
    args.length === 0
      ? (path: string) => augment(defineChildContextBase<RouteContext<string, object>>()(path))
      : augment(defineChildContextBase(args[0], args[1]))) as never;

  return {
    defineRootContext,
    defineChildContext,
    defineRootRoute: defineRootContext,
    defineChildRoute: defineChildContext,
  };
}
