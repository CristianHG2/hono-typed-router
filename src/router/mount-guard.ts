import type { RouteContext } from '../definitions';
import { getRouteIdentity } from '../definitions/lib';

/** The public function that a runtime error names after the `hono-typed-router:` prefix. */
export type RouterCaller = 'makeRouter' | 'mountRouter';

/** @internal */
export type RouterMount = {
  readonly caller: RouterCaller;
  /** The full path of the parent router. */
  readonly basePath: string;
  readonly lineage?: readonly symbol[];
};

/**
 * A value-form child under another context runs without the middlewares that its type
 * expects. Limit: a curried child has no recorded parent, so it passes.
 */
export function assertMountedUnderParent(
  context: RouteContext<string, object>,
  mount: RouterMount,
) {
  const identity = getRouteIdentity(context);

  if (identity?.parentId === undefined || mount.lineage?.includes(identity.parentId)) {
    return;
  }

  const mountedUnder =
    mount.basePath === identity.parentPath
      ? `an ancestor or an unrelated context with the same path '${mount.basePath}' (for example, the context before a .middleware() call, or a different root with the same path)`
      : `the context at '${mount.basePath}'`;

  throw new TypeError(
    `hono-typed-router: ${mount.caller}: the child context '${context.path}' was defined under the context at '${identity.parentPath}', but its router is mounted under ${mountedUnder}. Mount the router of a child under the router of the context that it was defined from, or of a .middleware() descendant of that context.`,
  );
}
