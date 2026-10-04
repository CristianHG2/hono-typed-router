export { defineRootRoute, defineChildRoute } from './lib';

export type {
  RouteContext,
  MiddlewareFactory,
  ChildRouteFn,
  NoRedeclare,
  ContextEnv,
} from './types';

export { extendRouteContext } from './extend';

export type {
  RouteContextKind,
  ReaugmentContext,
  RouteContextBase,
  ExtensionNames,
  ExtensionBuilders,
  ExtendRouteContextResult,
} from './extend';
