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

## Error handling

### `handler(c, fn)`

```ts
function handler<I extends Input, TResponse>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<TResponse>,
): HandlerInvocation<TResponse>;

type ValidatedProxy<I extends Input> = {
  [K in keyof ValidationTargets]: InputToDataByTarget<I['out'], K>;
};
```

Wraps a route handler body. `fn` receives a `ValidatedProxy` — a destructurable view over the request's validated inputs (`param`, `query`, `json`, `form`, `header`, `cookie`), each typed from the route's `Input`. Every target is read from `c.req.valid` **lazily and cached**: untouched targets are never read, and a touched target is read once.

The body runs at most once, whether awaited directly (thenable) or via `.errors([...])`.

### `HandlerInvocation<TResponse>`

```ts
type HandlerInvocation<TResponse> = Promise<TResponse> &
  Readonly<{
    errors: <const TArms extends ReadonlyArray<AnyArm>>(
      arms: TArms,
    ) => Promise<TResponse | ArmsResponse<TArms>>;
  }>;
```

Awaitable result of `handler`. On its own it settles to `TResponse`. Calling `.errors(arms)` runs the body under `handleErrors` and widens the result with each arm's response type. Because that widened value is what you return to `router.openapi(...)`, **an arm that emits a status the route did not declare in `responses` is a compile error** — the OpenAPI contract and the runtime handler cannot drift apart.

### `on(ctor, handle)`

```ts
function on<TErr extends Error, TResult>(
  ctor: new (...args: any[]) => TErr,
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>,
): ErrorArm<TErr, TResult>;
```

Declares an **error arm**: match errors that are `instanceof ctor`, then run `handle`. `TResult` is inferred from the handler's return, so the arm carries the exact response type it produces (e.g. `c.json(body, status)`'s `TypedResponse`). Return `rethrow()` to decline and fall through to the next arm.

### `rethrow()` / `RETHROW`

```ts
const RETHROW: unique symbol;
type Rethrow = typeof RETHROW;
function rethrow(): Rethrow;
```

`rethrow()` returns the `RETHROW` sentinel (compared by identity). An arm returning it defers to the next matching arm; if none matches, the original error is rethrown. `Rethrow` responses never leak into the widened return type.

### `handleErrors(body, arms, c)`

```ts
function handleErrors<TBody, const TArms extends ReadonlyArray<ErrorArm<any, any>>>(
  body: () => Promise<TBody>,
  arms: TArms,
  c: Context,
): Promise<TBody | Exclude<Awaited<ArmResults<TArms>>, Rethrow>>;
```

The dispatch behind `.errors([...])`, usable on its own when you don't need the input proxy. Runs `body()`; if it throws an `Error`, the first arm whose `ctor` matches (by `instanceof`) handles it, arms are tried in order, and an arm returning `rethrow()` falls through. Non-`Error` throws bypass the arms. The return type is `TBody` widened with each arm's response (awaited, minus the `Rethrow` sentinel).

### `genericErrorHandler(status)`

```ts
function genericErrorHandler<T extends ContentfulStatusCode>(
  statusCode: T,
): (err: Error, c: Context) => TypedResponse<{ message: string }, T, 'json'>;
```

Convenience arm handler that responds with `{ message: err.message }` at the given status. Compose with `on`: `on(SomeError, genericErrorHandler(409))`.

## Extending the `define[x]` context

### `extendRouteContext<K>(builders)`

```ts
function extendRouteContext<K extends RouteContextKind>(
  builders: ExtensionBuilders<K>,
): ExtendRouteContextResult<K>;

interface ExtendRouteContextResult<K extends RouteContextKind> {
  defineRootRoute: <TPath extends string, TVars extends object = object>(
    path: TPath,
    middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
  ) => ReaugmentContext<K, TPath, TVars>;
  defineChildRoute: <TParentContext>() => <TPath extends string>(
    path: TPath,
  ) => ReaugmentContext<K, `${ParentPath}${TPath}`, ParentVars>;
}
```

Returns `defineRootRoute`/`defineChildRoute` whose contexts carry custom builder methods in addition to `.middleware()`. Each method threads the route's path and accumulated vars, and the augmentation is re-applied automatically through `.middleware()` and through the methods' own return values, so the builders survive chaining.

Describe the extended context as a self-referential **interface** extending `RouteContextBase` (an interface is the recursion boundary TypeScript needs — a mapped-type alias would trip "excessively deep"), pair it with a one-line `RouteContextKind`, then pass the kind as the type argument and the runtime builders as the argument.

### Supporting types

```ts
// Higher-kinded slot mapping (path, vars) onto your context interface.
interface RouteContextKind {
  readonly path: string;
  readonly vars: object;
  readonly type: unknown;
}

// Evaluates a kind at concrete path/vars — the re-augmented context type.
type ReaugmentContext<K extends RouteContextKind, TPath extends string, TVars extends object> =
  (K & { path: TPath; vars: TVars })['type'];

// Base members (path, vars, middlewares, kind-aware middleware) your interface extends.
interface RouteContextBase<K extends RouteContextKind, TPath extends string, TVars extends object>
  extends Omit<RouteContext<TPath, TVars>, 'middleware'> {
  middleware: <TNewVars extends object>(
    handler: /* MiddlewareHandler, or a redeclaration-guard string */,
  ) => ReaugmentContext<K, TPath, TVars & TNewVars>;
}

// The custom builder names a kind adds on top of RouteContextBase.
type ExtensionNames<K extends RouteContextKind>;

// The runtime builders map: { [name]: (ctx) => (...args) => ctx.middleware(...) }.
type ExtensionBuilders<K extends RouteContextKind>;
```

A full worked example (with `bindRepository`, `ParamKeys`, and the redeclaration guard) is in the README under *Extending the `define[x]` context* and in `docs/usage.md`.
