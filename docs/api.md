# API reference

All exports come from the package root `hono-typed-router` unless otherwise noted.

## `defineRootRoute(path, middlewares)`

```ts
function defineRootRoute<TPath extends string, TVars extends object>(
  path: TPath,
  middlewares: MiddlewareHandler<{ Variables: TVars }>[],
): RouteContext<TPath, TVars>;
```

Creates the root `RouteContext`. The `path` is preserved as a literal type. `middlewares` run on every router built from this context.

## `defineChildRoute<typeof parent>()(path)`

```ts
function defineChildRoute<TParentContext>(): <TPath extends string>(
  path: TPath,
) => RouteContext<`${ParentPath}${TPath}`, ParentVars>;
```

Creates a child `RouteContext`. The double invocation is intentional — TypeScript can infer the path type literal only when the parent type is supplied explicitly in the first call.

## `RouteContext<TPath, TVars>`

```ts
interface RouteContext<TPath extends string, TVars extends object> {
  path: TPath;
  vars: TVars;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars>;
}
```

- `path` — the literal path string carried at the type level.
- `vars` — a phantom value of the accumulated variables; useful only for type inspection.
- `middlewares` — the runtime list of middlewares applied by `makeRouter`.
- `middleware<NewVars>(handler)` — returns a new context with `handler` appended and `NewVars` merged into `TVars`. Attempting to redeclare an existing key produces a string-typed error position rather than accepting the handler.

## `createRouter(options?)`

```ts
function createRouter(options?: CreateRouterOptions): MakeRouterFn;

interface CreateRouterOptions {
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
}

type RouteMiddlewareFactory = (route: RouteConfig) => MiddlewareHandler;
```

Returns a `makeRouter`. The `routeMiddleware` factories are invoked once **at route declaration time** with the resolved `RouteConfig` (the `createRoute()` output). The returned middlewares are attached to the route's exact method + path. They are method-gated, so other methods on the same path are unaffected.

When an array is supplied, middlewares run in array order. Each middleware can call `next()` to continue or return a `Response` to short-circuit — Hono's standard middleware contract.

## `makeRouter(context, factory, children?)`

```ts
function makeRouter<TPath, TVars, TFactoryResult>(
  context: RouteContext<TPath, TVars>,
  factory: (options: {
    router: OpenAPIHono<{ Variables: TVars }>;
    route: MakeRouteFn<TPath>;
  }) => TFactoryResult,
  children?: (() => OpenAPIHono<any, any, any>)[],
): () => TFactoryResult;
```

Returns a **thunk** that, when invoked, builds and returns the router. The deferred invocation allows children to be mounted by a parent without ordering issues.

The `route(method, config)` argument supplied to `factory`:

- Calls `createRoute({ method, path: '/', ...config })` so that the route is registered at the context's base path.
- If `createRouter` was given `routeMiddleware`, attaches the resulting middleware(s) to this route's method + path.
- Returns the resolved `RouteConfig` for use with `router.openapi(config, handler)`.

## `createScopeMiddleware(options)` *(from `hono-typed-router/scopes`)*

```ts
function createScopeMiddleware(options: ScopeMiddlewareOptions): RouteMiddlewareFactory;

interface ScopeMiddlewareOptions {
  resolve: (c: Context) => readonly string[] | Promise<readonly string[]>;
  onForbidden?: (missingScopes: string[], c: Context) => unknown | Promise<unknown>;
}
```

A factory you can pass directly to `createRouter({ routeMiddleware })`. Extracts the required scopes from `route.security`, flattens them across schemes, and de-duplicates. If `resolve(c)` does not cover every required scope, responds **403** with either the default body (`{ error: 'E_FORBIDDEN', message: 'Missing <scopes> scope(s)' }`) or the value returned by `onForbidden`.

If a route has no `security`, the middleware is a no-op.

## Schema helpers

```ts
makeHonoResponse(schema, description);   // { description, content: { 'application/json': { schema } } }
makeHonoJsonBody(schema, description);   // same shape, for request bodies
makeHonoJsonRequest(schema, description); // { body: makeHonoJsonBody(...) }
makeHonoNoContentResponse(description);  // { description }
```

These are thin shape-builders for `@hono/zod-openapi` `createRoute()` configs.
