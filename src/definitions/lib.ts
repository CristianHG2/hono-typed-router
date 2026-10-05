import type { MiddlewareHandler } from 'hono';
import { createBindMiddleware } from './bind';
import type { BindLoader } from './bind';
import { assertHonoPath } from './path';
import type {
  DefineChildContextFn,
  DefineRootContextFn,
  ParentContext,
  RouteContext,
} from './types';

/**
 * Internal. `makeRouter` uses it to make sure that a value-form child mounts under its
 * parent context, or under a `.middleware()` descendant of that parent.
 */
export type RouteIdentity = {
  readonly id: symbol;
  /**
   * The ids of the `.middleware()` ancestors of this context, oldest first, and then `id`.
   * Roots and children start a new lineage.
   */
  readonly lineage: readonly symbol[];
  /** Absent on roots and curried children. */
  readonly parentId?: symbol;
  /** For the mis-mount error message. */
  readonly parentPath?: string;
};

// An enumerable symbol key, so that an object spread (as in `extendRouteContext`) copies it.
// `Object.keys` and `JSON.stringify` do not show it.
const IDENTITY: unique symbol = Symbol('hono-typed-router.identity');

export const getRouteIdentity = (context: ParentContext): RouteIdentity | undefined =>
  // SAFETY: only this module writes the `IDENTITY` key, and always with a `RouteIdentity`.
  (context as { [IDENTITY]?: RouteIdentity })[IDENTITY];

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
  const middleware = (handler: MiddlewareHandler) =>
    createRouteContext<TPath, TVars>(
      path,
      [...middlewares, handler],
      segment,
      parent,
      identity.lineage,
    );

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

// SAFETY: one implementation for both `DefineRootContextFn` signatures. The vars are a
// phantom, so both signatures return the same runtime context. An overloaded contextual type
// does not type the parameters, so they have annotations.
export const defineRootContext = ((path: string, middlewares: MiddlewareHandler[] = []) => {
  assertHonoPath('defineRootContext', path);

  return createRouteContext(path, middlewares);
}) as DefineRootContextFn;

/** @deprecated Use defineRootContext. Removed in 2.0. */
export const defineRootRoute = defineRootContext;

/** Internal. The runtime twin of `ChildPath`. Keep the two the same. */
export const joinChildPath = (parentPath: string, path: string): string => {
  if (path === '/' || path === '') return parentPath === '' ? path : parentPath;

  if (parentPath.endsWith('/')) {
    return path.startsWith('/') ? `${parentPath.slice(0, -1)}${path}` : `${parentPath}${path}`;
  }

  return path === '' || path.startsWith('/') ? `${parentPath}${path}` : `${parentPath}/${path}`;
};

// SAFETY: one implementation for both `DefineChildContextFn` overloads. The curried form
// keeps the runtime path relative, but its type is the full path. No code reads that runtime
// path before the mount, and the mount applies the parent base path. Neither form copies the
// parent middlewares, because the parent router runs them after the mount.
export const defineChildContext = ((...args: [] | [ParentContext, string]) => {
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
}) as DefineChildContextFn;

/** @deprecated Use defineChildContext. Removed in 2.0. */
export const defineChildRoute = defineChildContext;
