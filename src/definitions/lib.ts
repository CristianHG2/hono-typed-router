import type { MiddlewareHandler } from 'hono';
import type { DefineChildRouteFn, DefineRootRouteFn, RouteContext } from './types';

function createRouteContext<TPath extends string, TVars extends object>(
  path: TPath,
  middlewares: MiddlewareHandler[],
): RouteContext<TPath, TVars> {
  return {
    path,
    // SAFETY: `vars` is a phantom type carrier; it is never read at runtime.
    vars: {} as TVars,
    middlewares,

    // SAFETY: the generic `middleware` only widens `TVars` at the type level; at runtime it
    // appends the handler, which is all this implementation does.
    middleware: ((handler: MiddlewareHandler) => {
      return createRouteContext(path, [...middlewares, handler]);
    }) as RouteContext<TPath, TVars>['middleware'],
  };
}

export const defineRootRoute: DefineRootRouteFn = (path, middlewares) => {
  return createRouteContext(path, middlewares);
};

export const defineChildRoute: DefineChildRouteFn = () => {
  // The runtime path stays relative: the parent's basePath applies when the child is mounted.
  // SAFETY: the context's type-level path is `ChildPath<parent, path>`; only the runtime
  // value stays relative (see above), and nothing reads it before mounting.
  return (path) => createRouteContext(path, []) as never;
};
