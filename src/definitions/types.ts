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
  /**
   * Internal: the path relative to the parent, which `makeRouter` uses as the router's
   * base path so that mounting under the parent does not prefix the parent path twice.
   * Equals `path` for root contexts and curried children; for a value-form
   * `defineChildRoute(parent, segment)` child, `path` is the full path and this is
   * `segment`. When absent, `makeRouter` uses `path`.
   */
  readonly segment?: string;
}

export type DefineRootRouteFn = <TPath extends string, TVars extends object = {}>(
  path: TPath,
  middlewares: MiddlewareHandler<{ Variables: TVars }>[],
) => RouteContext<TPath, TVars>;

/** Anything carrying a path literal and a vars phantom: a base or an extended context. */
export type ParentContext = { path: string; vars: object };

/**
 * A child's full path: the parent's path joined with the child's own segment by one `/`.
 * A parent path that ends in `/` (the root `'/'`) drops that slash when the segment starts
 * with one, so `'/'` + `'/things'` is `'/things'`, not `'//things'`. A segment without a
 * leading `/` under a parent that does not end in one gets one inserted, so `'/api'` +
 * `'things'` is `'/api/things'`. Mirrors `joinChildPath`.
 */
export type ChildPath<
  TParentPath extends string,
  TPath extends string,
> = TParentPath extends `${infer THead}/`
  ? TPath extends `/${string}`
    ? `${THead}${TPath}`
    : `${TParentPath}${TPath}`
  : string extends TPath
    ? `${TParentPath}${TPath}`
    : TPath extends `/${string}` | ''
      ? `${TParentPath}${TPath}`
      : `${TParentPath}/${TPath}`;

export type ChildRouteFn<TParentContext extends ParentContext> = <TPath extends string>(
  path: TPath,
) => RouteContext<ChildPath<TParentContext['path'], TPath>, TParentContext['vars']>;

export interface DefineChildRouteFn {
  /**
   * Value form: infers the parent's path and vars from the `parent` value. The child's
   * runtime `path` is `parent.path` joined with `path` by `/` (the full path when every ancestor is a root
   * or a value-form child; a parent `'/'` adds no extra slash). Needs the parent value at
   * module load, so use the curried form when the parent module imports the child's
   * router (a circular import).
   */
  <TPath extends string, TParentPath extends string, TParentVars extends object>(
    parent: { path: TParentPath; vars: TParentVars },
    path: TPath,
  ): RouteContext<ChildPath<TParentPath, TPath>, TParentVars>;
  /**
   * Curried form: the parent is passed as a type only, so the child module needs no
   * runtime import of the parent (safe in a circular import). The child's runtime
   * `path` is its own segment.
   */
  <TParentContext extends ParentContext>(): ChildRouteFn<TParentContext>;
}
