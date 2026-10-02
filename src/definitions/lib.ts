import type { MiddlewareHandler } from 'hono';
import type { DefineChildRouteFn, DefineRootRouteFn, ParentContext, RouteContext } from './types';

function createRouteContext<TPath extends string, TVars extends object>(
  path: TPath,
  middlewares: MiddlewareHandler[],
  segment: string = path,
): RouteContext<TPath, TVars> {
  return {
    path,
    segment,
    // SAFETY: `vars` is a phantom type carrier; it is never read at runtime.
    vars: {} as TVars,
    middlewares,

    // SAFETY: the generic `middleware` only widens `TVars` at the type level; at runtime it
    // appends the handler, which is all this implementation does.
    middleware: ((handler: MiddlewareHandler) => {
      return createRouteContext(path, [...middlewares, handler], segment);
    }) as RouteContext<TPath, TVars>['middleware'],
  };
}

export const defineRootRoute: DefineRootRouteFn = (path, middlewares) => {
  return createRouteContext(path, middlewares);
};

/**
 * Runtime twin of `ChildPath`: joins with exactly one `/`. A parent `'/'` (or trailing `/`)
 * does not double the slash, and a segment without a leading `/` gets one.
 */
const joinChildPath = (parentPath: string, path: string): string => {
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
// in either form: mounting under the parent router runs them.
export const defineChildRoute = ((...args: [] | [ParentContext, string]) =>
  args.length === 0
    ? (path: string) => createRouteContext(path, [])
    : createRouteContext(joinChildPath(args[0].path, args[1]), [], args[1])) as DefineChildRouteFn;
