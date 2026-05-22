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
function createRouter<const TBase extends BaseRouteConfig = {}>(
  options?: CreateRouterOptions<TBase>,
): MakeRouterFn<TBase>;

interface CreateRouterOptions<TBase extends BaseRouteConfig = {}> {
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  base?: TBase;
  transformRoute?: (config: RouteConfig) => RouteConfig;
}

type BaseRouteConfig = Partial<Omit<RouteConfig, 'method' | 'path'>>;
type RouteMiddlewareFactory = (route: RouteConfig) => MiddlewareHandler;
```

Returns a `makeRouter`. Options:

- **`routeMiddleware`** — factories invoked once **at route declaration time** with the resolved `RouteConfig` (the `createRoute()` output). The returned middlewares are attached to the route's exact method + path and are method-gated, so other methods on the same path are unaffected. When an array is supplied, middlewares run in array order. Each middleware can call `next()` to continue or return a `Response` to short-circuit — Hono's standard middleware contract.

- **`base`** — a partial `RouteConfig` deep-merged into every route declared via this router. Pipeline order: `base` ⊕ per-route config → `createRoute()` → `transformRoute` → `routeMiddleware` factories → returned to caller. Merge rules:
  - **Plain objects** recurse key-by-key (e.g. `responses[200]`, `request.params`).
  - **Arrays** are concatenated and structurally deduplicated (e.g. `security`, `tags`).
  - **Zod schemas** at the same merge position are unioned via `baseSchema.or(routeSchema)`. Useful when both `base` and the route declare e.g. `responses[422]` with different validation-error shapes.
  - **All other leaf conflicts** are won by the per-route value.

  The merged shape is reflected in the static return type of `route()`, so handlers see the combined `responses`/`request` (with `ZodUnion<readonly [base, route]>` at colliding schema slots).

- **`transformRoute`** — a runtime-only `(RouteConfig) => RouteConfig` hook applied immediately after `createRoute()` (and after the `base` merge), before `routeMiddleware` factories receive the config and before it is returned to the caller. The static return type of `route()` is **not** affected by this hook; it is an escape hatch for cross-cutting mutations (auto-tagging, injecting `operationId`, normalizing security entries, etc.).

## `BaseRouteConfig` and `DeepMerge<A, B>`

```ts
type BaseRouteConfig = Partial<Omit<RouteConfig, 'method' | 'path'>>;
type DeepMerge<A, B> = /* see source */;
```

Exported as type-only helpers. `DeepMerge` is the type-level equivalent of the runtime merge: it recurses through plain objects, tuple-concatenates arrays, produces `ZodUnion<readonly [A, B]>` when both sides are `ZodType`, and otherwise has the second argument win. Use it to type external wrappers that build configs from the same `base`.

## `makeRouter(context, factory, children?)`

```ts
function makeRouter<TPath, TVars, TFactoryResult>(
  context: RouteContext<TPath, TVars>,
  factory: (options: {
    router: OpenAPIHono<{ Variables: TVars }>;
    route: MakeRouteFn<TPath, TBase>;
  }) => TFactoryResult,
  children?: (() => OpenAPIHono<any, any, any>)[],
): () => TFactoryResult;
```

`TBase` is threaded from `createRouter`'s options, so `route()`'s return type reflects the configured `base`.

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
