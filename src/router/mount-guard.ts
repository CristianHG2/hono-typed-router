import type { RouteContext } from '../definitions';
import { getRouteIdentity } from '../definitions/lib';

/** The public function that a runtime error names after the `hono-typed-router:` prefix. */
export type RouterCaller = 'makeRouter' | 'mountRouter';

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * Internal argument a parent thunk passes to each child thunk it mounts.
 */
export type RouterMount = {
  /** The function that mounts the child: `makeRouter`, or `mountRouter` for its children. */
  readonly caller: RouterCaller;
  /** The parent's full mount path: where the parent router itself is served. */
  readonly basePath: string;
  /** The lineage of the parent's context, to detect a value-form child mounted elsewhere. */
  readonly lineage?: readonly symbol[];
};

/**
 * Throws when a value-form child is mounted under a context that is not the one it was
 * defined from or a `.middleware()` descendant of it. Under an ancestor or an unrelated
 * context, its routes would run without some of the middlewares that its type assumes.
 * Curried children have no recorded parent, so they are not checked.
 */
export const assertMountedUnderParent = (
  context: RouteContext<string, object>,
  mount: RouterMount,
) => {
  const identity = getRouteIdentity(context);

  if (identity?.parentId === undefined || mount.lineage?.includes(identity.parentId)) return;

  const mountedUnder =
    mount.basePath === identity.parentPath
      ? `an ancestor or an unrelated context with the same path '${mount.basePath}' (for example, the context before a .middleware() call, or a different root with the same path)`
      : `the context at '${mount.basePath}'`;

  throw new TypeError(
    `hono-typed-router: ${mount.caller}: the child context '${context.path}' was defined under the context at '${identity.parentPath}', but its router is mounted under ${mountedUnder}. Mount the router of a child under the router of the context that it was defined from, or of a .middleware() descendant of that context.`,
  );
};
