import type { MiddlewareHandler } from 'hono';

/**
 * Constraint for a `.middleware<TNewVars>()` type argument: every key that already
 * exists in `TOld` maps to an error string, so redeclaring a var fails on the type
 * argument itself (one TS2344) rather than on the handler.
 */
export type NoRedeclare<TNew, TOld> = {
  [K in keyof TNew]: K extends keyof TOld
    ? `Cannot redeclare existing var: ${K & string}`
    : TNew[K];
};

export type MiddlewareFactory<TPath extends string, TVars extends object> = <
  TNewVars extends NoRedeclare<TNewVars, TVars> = {},
>(
  handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
) => RouteContext<TPath, TVars & TNewVars>;

export interface RouteContext<TPath extends string, TVars extends object> {
  path: TPath;
  vars: TVars;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars>;
}

export type DefineRootRouteFn = <TPath extends string, TVars extends object = {}>(
  path: TPath,
  middlewares: MiddlewareHandler<{ Variables: TVars }>[],
) => RouteContext<TPath, TVars>;

/** Anything carrying a path literal and a vars phantom: a base or an extended context. */
export type ParentContext = { path: string; vars: object };

/** A child's full path: the parent's path followed by the child's own segment. */
export type ChildPath<
  TParent extends ParentContext,
  TPath extends string,
> = `${TParent['path']}${TPath}`;

export type ChildRouteFn<TParentContext extends ParentContext> = <TPath extends string>(
  path: TPath,
) => RouteContext<ChildPath<TParentContext, TPath>, TParentContext['vars']>;

export type DefineChildRouteFn = <
  TParentContext extends ParentContext,
>() => ChildRouteFn<TParentContext>;
