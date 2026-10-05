import type { MiddlewareHandler } from 'hono';
import type { BindKey, BindLoader, BindParam } from './bind';
import {
  defineChildContext as defineChildContextBase,
  defineRootContext as defineRootContextBase,
} from './lib';
import type { ChildPath } from './path';
import type { CheckRootArray, FoldVars } from './root-array';
import type {
  CheckMiddlewareFits,
  DeferredChildContextFn,
  HandlerSets,
  NoRedeclare,
  ParentContext,
  RouteContext,
} from './types';

/**
 * Higher-kinded slot used to pass an (unapplied) two-parameter context interface
 * to {@link extendRouteContext}. Implement it with a one-liner that maps the
 * `path`/`vars` slots onto your context interface:
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
 * Evaluates a {@link RouteContextKind} at a concrete `path`/`vars` — i.e. the
 * re-augmented context type. Because a `RouteContextKind`'s `type` resolves to an
 * *interface* (a lazy reference), using this in a method's return position chains
 * without tripping "excessively deep" instantiation.
 */
export type ReaugmentContext<
  K extends RouteContextKind,
  TPath extends string,
  TVars extends object,
> = (K & { readonly path: TPath; readonly vars: TVars })['type'];

/**
 * Base members every extended context interface should carry. Extend this in your
 * context interface and add your custom builders, each returning
 * `ReaugmentContext<YourKind, TPath, TVars & NewVars>`:
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
 * `middleware` and `bind` are provided here (re-augmenting through the kind), so your
 * interface only declares the extra builders. Do not declare a builder with one of these names.
 */
export interface RouteContextBase<
  K extends RouteContextKind,
  TPath extends string,
  TVars extends object,
> extends Omit<RouteContext<TPath, TVars>, 'middleware' | 'bind'> {
  middleware: {
    /** An inline handler; see the first signature of `MiddlewareFactory`. Must stay first. */
    <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
      handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
    ): ReaugmentContext<K, TPath, TVars & TNewVars>;
    /** A reusable typed middleware; see the second signature of `MiddlewareFactory`. */
    <THandler extends MiddlewareHandler<any, any, any>, _NoExplicitTypeArgs>(
      handler: THandler & CheckMiddlewareFits<THandler, TVars>,
    ): ReaugmentContext<K, TPath, TVars & HandlerSets<THandler>>;
  };
  /** See `RouteContext.bind`. The returned context keeps the builders of `K`. */
  bind: <TKey extends string, TValue, _TLoaderVars extends TVars = TVars>(
    key: BindKey<TKey, _TLoaderVars>,
    param: BindParam<TPath>,
    load: BindLoader<_TLoaderVars, TValue>,
  ) => ReaugmentContext<K, TPath, TVars & { [Key in TKey]: NonNullable<Awaited<TValue>> }>;
}

type BaseKeys = keyof RouteContextBase<RouteContextKind, string, object>;

/**
 * The names of the custom builders a `K` adds on top of {@link RouteContextBase}.
 * Used to require exactly those builders in {@link extendRouteContext}.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ExtensionNames<K extends RouteContextKind> = Exclude<
  keyof ReaugmentContext<K, string, object>,
  BaseKeys
>;

/**
 * Runtime builders for a `K`'s custom methods. Each builder receives the augmented
 * context (whose `.middleware()` and other builders already re-augment) and returns
 * the method implementation. The implementation's parameters are typed from the
 * context interface's method (at a loose `string` path / `object` vars), and it must
 * return a context. The precise, path/vars-aware signature callers see comes from
 * the context interface.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export type ExtensionBuilders<K extends RouteContextKind> = {
  [Name in ExtensionNames<K> & string]: (
    ctx: ReaugmentContext<K, string, object>,
  ) => (
    ...args: ParamsOf<ReaugmentContext<K, string, object>[Name]>
  ) => ReaugmentContext<K, string, object>;
};

// `Parameters<>` cannot be used here: its `(...args: any) => any` constraint is not
// provably met by an indexed access into the kind (TS2344).
type ParamsOf<T> = T extends (...args: infer P) => unknown ? P : never;

/**
 * The augmented `define[x]` entry points returned by {@link extendRouteContext}.
 *
 * @internal Exported for declaration emit; not part of the public API.
 */
export interface ExtendRouteContextResult<K extends RouteContextKind> {
  defineRootContext: {
    /**
     * See the first signature of the base `defineRootContext`. Must stay first, so that
     * TypeScript tries it before the fold signature. One or two explicit type arguments
     * always select it.
     */
    <TPath extends string, TVars extends object = {}>(
      path: TPath,
      middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
    ): ReaugmentContext<K, TPath, TVars>;
    /**
     * Fold: see the second signature of the base `defineRootContext`. TypeScript can also
     * select it for an array of one kind; the vars are then the same. Three explicit type
     * arguments select it.
     *
     * `_TVars` is internal: do not pass it. Four explicit type arguments set the vars to the
     * fourth argument, and nothing checks them. It is a type parameter only so that the vars
     * reach the kind as a type parameter constrained to `object`. A kind evaluates
     * `this['vars'] & object`, which TypeScript simplifies to `_TVars` for a type parameter.
     * A concrete `{}` does not simplify: `{} & object` is `object`, so a direct
     * `FoldVars<TMws>` gives `object` vars for a `MiddlewareHandler[]` variable and a
     * leading `object &` for typed middlewares.
     */
    <
      TPath extends string,
      TMws extends readonly MiddlewareHandler[],
      _NoExplicitTypeArgs,
      _TVars extends object = FoldVars<TMws>,
    >(
      path: TPath,
      middlewares?: readonly [...TMws] & CheckRootArray<TMws>,
    ): ReaugmentContext<K, TPath, _TVars>;
  };
  defineChildContext: {
    /** Value form; see the base `defineChildContext`. */
    <TPath extends string, TParentPath extends string, TParentVars extends object>(
      parent: { path: TParentPath; vars: TParentVars },
      path: TPath,
    ): ReaugmentContext<K, ChildPath<TParentPath, TPath>, TParentVars>;
    /** Curried form (type-only parent); see the base `defineChildContext`. */
    <TParentContext extends ParentContext>(): DeferredChildContextFn<
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
 * Extends the `define[x]` context builders with custom, type-safe methods.
 *
 * Generalizes augmenting a `RouteContext` with extra builders (a `bindRepository`,
 * a `bindValue`, ...): the returned `defineRootContext`/`defineChildContext` produce
 * contexts carrying your builders, each method threads the route's path and
 * accumulated vars, and the augmentation is re-applied automatically through
 * `.middleware()` and through the builders' own return values — so the methods are
 * never lost mid-chain.
 *
 * Describe the extended context as a self-referential interface extending
 * {@link RouteContextBase}, pair it with a {@link RouteContextKind}, then pass the
 * kind as the type argument and the matching runtime builders as the argument:
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
      // SAFETY: `RouteContext.middleware` is generic only over the vars type; at runtime it
      // takes one handler and returns a new `RouteContext`.
      middleware: (handler: MiddlewareHandler) =>
        augment(
          (base.middleware as (h: MiddlewareHandler) => RouteContext<string, object>)(handler),
        ),
      // SAFETY: `RouteContext.bind` is generic only over the key and the value type; at runtime
      // it takes a key, a param and a loader, and returns a new `RouteContext`.
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

    // SAFETY: `augmented` is a copy of `base` with `middleware` re-wrapped and builders added.
    return augmented as unknown as RouteContext<string, object>;
  };

  // SAFETY: both entry points return `augment`ed contexts, which `ExtendRouteContextResult<K>`
  // describes through the kind `K`; the erased runtime signatures cannot express that.
  const defineRootContext = ((path: string, middlewares: MiddlewareHandler[] = []) =>
    augment(defineRootContextBase(path, middlewares))) as never;

  // SAFETY: as for `defineRootContext` above, for both forms of the child.
  const defineChildContext = ((...args: [] | [ParentContext, string]) =>
    args.length === 0
      ? (path: string) => augment(defineChildContextBase<RouteContext<string, object>>()(path))
      : augment(defineChildContextBase(args[0], args[1]))) as never;

  // The deprecated keys hold the same functions as the new keys.
  return {
    defineRootContext,
    defineChildContext,
    defineRootRoute: defineRootContext,
    defineChildRoute: defineChildContext,
  };
}
