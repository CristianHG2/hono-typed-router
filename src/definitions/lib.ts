import type { MiddlewareHandler } from 'hono';
import { createBindMiddleware } from './bind';
import type { BindLoader } from './bind';
import { assertHonoPath } from './path';
import type { ChildPath } from './path';
import type { RouterEnv } from './env';
import type { CheckRootArray, FoldBindings, FoldVars } from './root-array';
import type { ChildRouteFn, DeferredChildContextFn, ParentContext, RouteContext } from './types';

/**
 * Internal. `makeRouter` uses it to make sure that a value-form child mounts under its parent
 * context, or under a `.middleware()` descendant of that parent.
 */
export type RouteIdentity = {
  readonly id: symbol;
  /** The ids of the `.middleware()` ancestors of this context, oldest first, and then `id`. */
  readonly lineage: readonly symbol[];
  readonly parentId?: symbol;
  readonly parentPath?: string;
};

// A symbol key, so that an object spread (as in `extendRouteContext`) copies it, but
// `Object.keys` and `JSON.stringify` do not show it.
const IDENTITY: unique symbol = Symbol('hono-typed-router.identity');

export function getRouteIdentity(context: ParentContext): RouteIdentity | undefined {
  // SAFETY: only this module writes the `IDENTITY` key, and always with a `RouteIdentity`.
  return (context as { [IDENTITY]?: RouteIdentity })[IDENTITY];
}

type ParentLink = Omit<RouteIdentity, 'id' | 'lineage'>;

function createRouteContext<TPath extends string, TVars extends object>(
  path: TPath,
  middlewares: MiddlewareHandler[],
  segment: string = path,
  parent: ParentLink = {},
  sourceLineage: readonly symbol[] = [],
): RouteContext<TPath, TVars> {
  const id = Symbol(path);
  const identity: RouteIdentity = { id, lineage: [...sourceLineage, id], ...parent };

  // The lineage carries over, so that children of this context can mount under the new one.
  function middleware(handler: MiddlewareHandler) {
    return createRouteContext<TPath, TVars>(
      path,
      [...middlewares, handler],
      segment,
      parent,
      identity.lineage,
    );
  }

  // SAFETY: the `IDENTITY` key is not part of the public `RouteContext` type.
  return {
    path,
    segment,
    // SAFETY: `vars` is a phantom. No code reads it at runtime.
    vars: {} as TVars,
    bindings: {},
    middlewares,
    [IDENTITY]: identity,

    // SAFETY: the generic `middleware` changes only the types. At runtime it appends the handler.
    middleware: middleware as RouteContext<TPath, TVars>['middleware'],

    // SAFETY: `bind` changes only the types. At runtime it appends a middleware through
    // `middleware`, so the new context gets the same lineage.
    bind: (<TValue>(key: string, param: string, load: BindLoader<object, TValue>) =>
      middleware(createBindMiddleware(key, param, load))) as RouteContext<TPath, TVars>['bind'],
  } as RouteContext<TPath, TVars>;
}

/**
 * The vars and the bindings come from the type arguments, or from the middlewares when they
 * all declare the same `Variables` and `Bindings`. Keep this signature first, so that
 * TypeScript tries it before the fold signature. One to three explicit type arguments select it.
 */
export function defineRootContext<
  TPath extends string,
  TVars extends object = {},
  TBindings extends object = {},
>(
  path: TPath,
  middlewares?: MiddlewareHandler<RouterEnv<TVars, TBindings>>[],
): RouteContext<TPath, TVars, TBindings>;
/**
 * Fold: the vars and the bindings are the intersections of the `Variables` and the `Bindings`
 * of the middlewares. The two `_NoExplicitTypeArgs` parameters have no default, so one to three
 * explicit type arguments cannot select this signature. `docs/api.md` lists the limits.
 */
export function defineRootContext<
  TPath extends string,
  TMws extends readonly MiddlewareHandler[],
  _NoExplicitTypeArgs,
  _NoExplicitTypeArgs2,
>(
  path: TPath,
  middlewares?: readonly [...TMws] & CheckRootArray<TMws>,
): RouteContext<TPath, FoldVars<TMws>, FoldBindings<TMws>>;
// The array is copied, so a later change to the array of the caller does not change the context.
export function defineRootContext(
  path: string,
  middlewares: readonly MiddlewareHandler[] = [],
): RouteContext<string, object> {
  assertHonoPath('defineRootContext', path);

  return createRouteContext(path, [...middlewares]);
}

/** @deprecated Use defineRootContext. Removed in 2.0. */
export const defineRootRoute = defineRootContext;

/** Internal. The runtime twin of `ChildPath`. Keep the two the same. */
export function joinChildPath(parentPath: string, path: string): string {
  if (path === '/' || path === '') {
    return parentPath === '' ? path : parentPath;
  }

  if (parentPath.endsWith('/')) {
    return path.startsWith('/') ? `${parentPath.slice(0, -1)}${path}` : `${parentPath}${path}`;
  }

  return path === '' || path.startsWith('/') ? `${parentPath}${path}` : `${parentPath}/${path}`;
}

/**
 * Value form: the child gets the path, the vars and the bindings of `parent`. The parent value
 * must exist at module load. If the parent module imports the router of the child (a circular
 * import), use the curried form.
 */
export function defineChildContext<
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
export function defineChildContext<TParentContext extends ParentContext>(): DeferredChildContextFn<
  TParentContext,
  ChildRouteFn<TParentContext>
>;
// The curried form keeps the runtime path relative, but its type is the full path. No code
// reads that runtime path before the mount, and the mount applies the parent base path. Neither
// form copies the parent middlewares, because the parent router runs them after the mount.
export function defineChildContext(
  ...args: [] | [ParentContext, string]
): RouteContext<string, object> | ((path: string) => RouteContext<string, object>) {
  if (args.length === 0) {
    return (path: string) => {
      assertHonoPath('defineChildContext', path);

      return createRouteContext(path, []);
    };
  }

  const [parent, segment] = args;
  assertHonoPath('defineChildContext', segment);

  return createRouteContext(joinChildPath(parent.path, segment), [], segment, {
    parentId: getRouteIdentity(parent)?.id,
    parentPath: parent.path,
  });
}

/** @deprecated Use defineChildContext. Removed in 2.0. */
export const defineChildRoute = defineChildContext;
