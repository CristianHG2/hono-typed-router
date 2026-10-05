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

  // The new context keeps the parent link but gets a new id, because it is a distinct
  // context. Its lineage extends this context's lineage, so children of this context can
  // mount under it.
  const middleware = (handler: MiddlewareHandler) =>
    createRouteContext<TPath, TVars>(
      path,
      [...middlewares, handler],
      segment,
      parent,
      identity.lineage,
    );

  // SAFETY: the `IDENTITY` key is internal and not part of the public `RouteContext` type.
  return {
    path,
    segment,
    // SAFETY: `vars` is a phantom type carrier; it is never read at runtime.
    vars: {} as TVars,
    bindings: {},
    middlewares,
    [IDENTITY]: identity,

    // SAFETY: the generic `middleware` only widens `TVars` at the type level; at runtime it
    // appends the handler, which is all this implementation does.
    middleware: middleware as RouteContext<TPath, TVars>['middleware'],

    // SAFETY: `bind` only widens `TVars` at the type level; at runtime it appends the
    // middleware of `createBindMiddleware` through `middleware`, so it gets the same identity.
    bind: (<TValue>(key: string, param: string, load: BindLoader<object, TValue>) =>
      middleware(createBindMiddleware(key, param, load))) as RouteContext<TPath, TVars>['bind'],
  } as RouteContext<TPath, TVars>;
}

// SAFETY: erased implementation of both `DefineRootContextFn` signatures. The vars type is a
// phantom, so both return the same runtime context. The parameters are annotated because an
// overloaded contextual type does not type them.
export const defineRootContext = ((path: string, middlewares: MiddlewareHandler[] = []) => {
  assertHonoPath('defineRootContext', path);

  return createRouteContext(path, middlewares);
}) as DefineRootContextFn;

/** @deprecated Use defineRootContext. Removed in 2.0. */
export const defineRootRoute = defineRootContext;

/**
 * Runtime twin of `ChildPath`: joins with exactly one `/`. A parent `'/'` (or trailing `/`)
 * does not double the slash, and a segment without a leading `/` gets one. A segment `'/'`
 * or `''` adds nothing to the parent path, as Hono's `basePath` and `route('/')` do, so
 * `'/api'` + `'/'` is `'/api'`. Under a root `''`, the segment `'/'` gives `'/'`. Internal;
 * also used by `makeRouter` to compute a mounted child's full path for `meta.path` and for
 * the duplicate check.
 */
export const joinChildPath = (parentPath: string, path: string): string => {
  if (path === '/' || path === '') return parentPath === '' ? path : parentPath;

  if (parentPath.endsWith('/')) {
    return path.startsWith('/') ? `${parentPath.slice(0, -1)}${path}` : `${parentPath}${path}`;
  }

  return path === '' || path.startsWith('/') ? `${parentPath}${path}` : `${parentPath}/${path}`;
};

// SAFETY: erased implementation of both `DefineChildContextFn` overloads. The value form
// returns a context whose runtime `path` is the full path its type promises, with the
// relative `segment` for mounting. The curried form keeps the runtime path relative (the
// parent's basePath applies when the child is mounted) while its type is the full path;
// nothing reads that runtime value before mounting. Parent middlewares are not copied
// in either form: mounting under the parent router runs them. Only the value form links
// the child to its parent's identity (see `RouteIdentity`). Both forms check the segment
// with `assertHonoPath`; the parent path was checked when the parent was defined.
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
