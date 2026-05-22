import type { MiddlewareHandler } from 'hono';

export type MiddlewareFactory<TPath extends string, TVars extends object> = <
  TNewVars extends object,
>(
  handler: keyof TNewVars & keyof TVars extends never
    ? MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>
    : `Cannot redeclare existing vars: ${Extract<keyof TNewVars & keyof TVars, string>}`,
) => RouteContext<TPath, TVars & TNewVars>;

export interface RouteContext<TPath extends string, TVars extends object> {
  path: TPath;
  vars: TVars;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars>;
}

export type DefineRootRouteFn = <TPath extends string, TVars extends object>(
  path: TPath,
  middlewares: MiddlewareHandler<{ Variables: TVars }>[],
) => RouteContext<TPath, TVars>;

export type ChildRouteFn<TParentContext> =
  TParentContext extends RouteContext<infer TParentPath, infer TParentVars>
    ? <TPath extends string>(path: TPath) => RouteContext<`${TParentPath}${TPath}`, TParentVars>
    : never;

export type DefineChildRouteFn = <TParentContext>() => ChildRouteFn<TParentContext>;
