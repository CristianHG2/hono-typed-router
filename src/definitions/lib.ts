import type { MiddlewareHandler } from 'hono';
import type { DefineChildRouteFn, DefineRootRouteFn, RouteContext } from './types';

function createRouteContext<TPath extends string, TVars extends object>(
  path: TPath,
  middlewares: MiddlewareHandler[],
): RouteContext<TPath, TVars> {
  return {
    path,
    vars: {} as TVars,
    middlewares,

    middleware: ((handler: MiddlewareHandler) => {
      return createRouteContext(path, [...middlewares, handler]);
    }) as RouteContext<TPath, TVars>['middleware'],
  };
}

export const defineRootRoute: DefineRootRouteFn = (path, middlewares) => {
  return createRouteContext(path, middlewares as MiddlewareHandler[]);
};

export const defineChildRoute: DefineChildRouteFn = () => {
  return ((path: string) => {
    return createRouteContext(path, []);
  }) as any;
};
