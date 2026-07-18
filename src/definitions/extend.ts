import type { MiddlewareHandler } from 'hono';
import { defineChildRoute as defineChildRouteBase, defineRootRoute as defineRootRouteBase } from './lib';
import type { RouteContext } from './types';

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
 * `middleware` is provided here (re-augmenting through the kind), so your interface
 * only declares the extra builders.
 */
export interface RouteContextBase<
  K extends RouteContextKind,
  TPath extends string,
  TVars extends object,
> extends Omit<RouteContext<TPath, TVars>, 'middleware'> {
  middleware: <TNewVars extends object>(
    handler: keyof TNewVars & keyof TVars extends never
      ? MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>
      : `Cannot redeclare existing vars: ${Extract<keyof TNewVars & keyof TVars, string>}`,
  ) => ReaugmentContext<K, TPath, TVars & TNewVars>;
}

type BaseKeys = keyof RouteContextBase<RouteContextKind, string, object>;

/**
 * The names of the custom builders a `K` adds on top of {@link RouteContextBase}.
 * Used to require exactly those builders in {@link extendRouteContext}.
 */
export type ExtensionNames<K extends RouteContextKind> = Exclude<
  keyof ReaugmentContext<K, string, object>,
  BaseKeys
>;

/**
 * Runtime builders for a `K`'s custom methods. Each builder receives the augmented
 * context (whose `.middleware()` and other builders already re-augment) and returns
 * the method implementation. The precise, path/vars-aware signature callers see
 * comes from the context interface; the builder body is checked against a loose
 * context.
 */
export type ExtensionBuilders<K extends RouteContextKind> = {
  [Name in ExtensionNames<K> & string]: (
    ctx: ReaugmentContext<K, string, object>,
  ) => (...args: any[]) => unknown;
};

/** The augmented `define[x]` entry points returned by {@link extendRouteContext}. */
export interface ExtendRouteContextResult<K extends RouteContextKind> {
  defineRootRoute: <TPath extends string, TVars extends object = object>(
    path: TPath,
    middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
  ) => ReaugmentContext<K, TPath, TVars>;
  defineChildRoute: <TParentContext>() => <TPath extends string>(
    path: TPath,
  ) => TParentContext extends {
    path: infer TParentPath extends string;
    vars: infer TParentVars extends object;
  }
    ? ReaugmentContext<K, `${TParentPath}${TPath}`, TParentVars>
    : never;
}

/**
 * Extends the `define[x]` context builders with custom, type-safe methods.
 *
 * Generalizes augmenting a `RouteContext` with extra builders (a `bindRepository`,
 * a `bindValue`, ...): the returned `defineRootRoute`/`defineChildRoute` produce
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
 * const { defineRootRoute, defineChildRoute } = extendRouteContext<CtxK>({
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
    const augmented: Record<string, unknown> = { ...base };
    augmented.middleware = (handler: MiddlewareHandler) =>
      augment((base.middleware as (h: MiddlewareHandler) => RouteContext<string, object>)(handler));

    for (const name of names) {
      augmented[name] = (builders as Record<string, (ctx: unknown) => unknown>)[name](augmented);
    }
    return augmented as unknown as RouteContext<string, object>;
  };

  return {
    defineRootRoute: ((path: string, middlewares: MiddlewareHandler[] = []) =>
      augment(defineRootRouteBase(path, middlewares))) as never,
    defineChildRoute: (() => (path: string) =>
      augment(defineChildRouteBase<RouteContext<string, object>>()(path))) as never,
  };
}
