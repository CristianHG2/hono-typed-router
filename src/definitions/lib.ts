import type { MiddlewareHandler } from 'hono';
import type { DefineChildRouteFn, DefineRootRouteFn, ParentContext, RouteContext } from './types';

/**
 * Internal identity of a context. `makeRouter` uses it to check that a value-form child is
 * mounted under the parent context it was defined from, or under a `.middleware()`
 * descendant of that parent.
 */
export type RouteIdentity = {
  /** Unique per context. A `.middleware()` call returns a context with a new id. */
  readonly id: symbol;
  /**
   * The ids of this context and of the contexts that it was derived from with `.middleware()`,
   * oldest first, ending with `id`. Roots and children start a new lineage.
   */
  readonly lineage: readonly symbol[];
  /** The id of the parent of a value-form child. Absent on roots and curried children. */
  readonly parentId?: symbol;
  /** The parent's runtime `path`, for the mis-mount error message. */
  readonly parentPath?: string;
};

// An enumerable symbol key: an object spread (as in `extendRouteContext`) copies it, while
// `Object.keys`, `JSON.stringify` and the public `RouteContext` type do not show it.
const IDENTITY: unique symbol = Symbol('hono-typed-router.identity');

/** Internal: reads the identity of a context, or `undefined` for a foreign object. */
export const getRouteIdentity = (context: ParentContext): RouteIdentity | undefined =>
  // SAFETY: only this module writes the `IDENTITY` key, always with a `RouteIdentity`.
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

  // SAFETY: the `IDENTITY` key is internal and not part of the public `RouteContext` type.
  return {
    path,
    segment,
    // SAFETY: `vars` is a phantom type carrier; it is never read at runtime.
    vars: {} as TVars,
    middlewares,
    [IDENTITY]: identity,

    // SAFETY: the generic `middleware` only widens `TVars` at the type level; at runtime it
    // appends the handler, which is all this implementation does. The new context keeps the
    // parent link but gets a new id, because it is a distinct context. Its lineage extends
    // this context's lineage, so children of this context can mount under it.
    middleware: ((handler: MiddlewareHandler) => {
      return createRouteContext(path, [...middlewares, handler], segment, parent, identity.lineage);
    }) as RouteContext<TPath, TVars>['middleware'],
  } as RouteContext<TPath, TVars>;
}

export const defineRootRoute: DefineRootRouteFn = (path, middlewares) => {
  return createRouteContext(path, middlewares);
};

/**
 * Runtime twin of `ChildPath`: joins with exactly one `/`. A parent `'/'` (or trailing `/`)
 * does not double the slash, and a segment without a leading `/` gets one. Internal; also
 * used by `makeRouter` to compute a mounted child's full path for `meta.path`.
 */
export const joinChildPath = (parentPath: string, path: string): string => {
  if (parentPath.endsWith('/')) {
    return path.startsWith('/') ? `${parentPath.slice(0, -1)}${path}` : `${parentPath}${path}`;
  }

  return path === '' || path.startsWith('/') ? `${parentPath}${path}` : `${parentPath}/${path}`;
};

// SAFETY: erased implementation of both `DefineChildRouteFn` overloads. The value form
// returns a context whose runtime `path` is the full path its type promises, with the
// relative `segment` for mounting. The curried form keeps the runtime path relative (the
// parent's basePath applies when the child is mounted) while its type is the full path;
// nothing reads that runtime value before mounting. Parent middlewares are not copied
// in either form: mounting under the parent router runs them. Only the value form links
// the child to its parent's identity (see `RouteIdentity`).
export const defineChildRoute = ((...args: [] | [ParentContext, string]) =>
  args.length === 0
    ? (path: string) => createRouteContext(path, [])
    : createRouteContext(joinChildPath(args[0].path, args[1]), [], args[1], {
        parentId: getRouteIdentity(args[0])?.id,
        parentPath: args[0].path,
      })) as DefineChildRouteFn;
