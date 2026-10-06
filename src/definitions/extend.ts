import type { MiddlewareHandler } from 'hono';
import type { BindKey, BindLoader, BindParam, CheckBindLoader } from './bind';
import {
  defineChildContext as defineChildContextBase,
  defineRootContext as defineRootContextBase,
} from './define-context';
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
 * Passes a context interface with two type parameters to {@link extendRouteContext}. Map the
 * `path` and `vars` slots to your context interface:
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
 * The context type of a {@link RouteContextKind} at a `path` and `vars`. TypeScript resolves the
 * interface in `type` lazily, so a long chain of methods that return this type does not hit the
 * "excessively deep" instantiation error.
 */
export type ReaugmentContext<
  K extends RouteContextKind,
  TPath extends string,
  TVars extends object,
> = (K & { readonly path: TPath; readonly vars: TVars })['type'];

/**
 * The base members of an extended context interface. Extend it in your context interface, and
 * return `ReaugmentContext<YourKind, TPath, TVars & NewVars>` from each builder. It declares
 * `middleware` and `bind`, so do not declare a builder with one of these names.
 */
export interface RouteContextBase<
  K extends RouteContextKind,
  TPath extends string,
  TVars extends object,
> extends Omit<RouteContext<TPath, TVars>, 'middleware' | 'bind'> {
  middleware: {
    /** An inline handler. Keep this signature first (see `MiddlewareFactory`). */
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

/** @internal */
export type ExtensionNames<K extends RouteContextKind> = Exclude<
  keyof ReaugmentContext<K, string, object>,
  BaseKeys
>;

/**
 * The method parameters come from the context interface at a `string` path and `object` vars.
 * Callers see the exact signature of the context interface.
 *
 * @internal
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

/** @internal */
export interface ExtendRouteContextResult<K extends RouteContextKind> {
  defineRootContext: {
    /** Keep this signature first (see `defineRootContext`). */
    <TPath extends string, TVars extends object = {}>(
      path: TPath,
      middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
    ): ReaugmentContext<K, TPath, TVars>;
    /**
     * Fold (see `defineRootContext`). Do not pass `_TVars`: four explicit type arguments set
     * the vars without a check. A kind evaluates `this['vars'] & object`. TypeScript simplifies
     * that to `_TVars` for a type parameter, but to `object` for a concrete `{}`, so a direct
     * `FoldVars<TMws>` gives the wrong vars.
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
    /** Value form (see `defineChildContext`). */
    <
      TPath extends string,
      TParentPath extends string,
      TParentVars extends object,
      TParentBindings extends BindingsSlot<TParentBindings> = {},
    >(
      parent: { path: TParentPath; vars: TParentVars; bindings?: TParentBindings },
      path: TPath,
    ): ReaugmentContext<K, ChildPath<TParentPath, TPath>, TParentVars>;
    /** Curried form (see `defineChildContext`). */
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
 * The contexts that `.middleware()`, `.bind()` and your builders return keep the methods. An
 * extended context does not carry Cloudflare `Bindings`. `docs/api.md` has an example.
 */
export function extendRouteContext<K extends RouteContextKind>(
  builders: ExtensionBuilders<K>,
): ExtendRouteContextResult<K> {
  const names = Object.keys(builders);

  function augment(base: RouteContext<string, object>): RouteContext<string, object> {
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
  }

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
