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

Context paths (`defineRootRoute` and `defineChildRoute`) must use Hono `:param` syntax. A context path written as `{param}` is mounted literally and returns 404, while `meta.path` reports it as `:param`. Only a route's own declared `path` is converted from `{param}` to `:param`.

## `defineChildRoute(parent, path)` / `defineChildRoute<typeof parent>()(path)`

```ts
// Value form
function defineChildRoute<
  TPath extends string,
  TParentPath extends string,
  TParentVars extends object,
>(
  parent: { path: TParentPath; vars: TParentVars },
  path: TPath,
): RouteContext<`${TParentPath}${TPath}`, TParentVars>;

// Curried form
function defineChildRoute<TParentContext extends { path: string; vars: object }>(): <
  TPath extends string,
>(
  path: TPath,
) => RouteContext<`${TParentContext['path']}${TPath}`, TParentContext['vars']>;
```

Creates a child `RouteContext` whose path type is the parent's path joined with `path` by `/`, and whose vars are the parent's. The join adds no second slash after a parent that ends in `/` (`'/'` + `'/things'` is `/things`) and inserts one when `path` has no leading `/` (`'/api'` + `'things'` is `/api/things`). Any `{ path; vars }` shape is accepted as the parent, including extended contexts. Neither form copies the parent's middlewares: mounting the child's router under the parent's router runs them.

- **Value form.** Infers the parent's path and vars from the `parent` value. The child's runtime `path` is `parent.path` joined with `path` by `/` (the full path when every ancestor is a root or a value-form child; a curried ancestor contributes only its segment); the relative part is kept in `segment` for mounting. The child also records which context it was created from. Its router can be mounted under the router of that context, or of a context derived from it with `.middleware()` (same lineage, more middleware). Mounting it under any other context throws an `Error` that names both paths. Examples are an ancestor (the parent before a `.middleware()` call), a sibling `.middleware()` branch, and an unrelated context.
- **Curried form.** Takes the parent as a type only, so the child's module needs only an `import type` of the parent. Use it when the parent's module imports the child's router (a circular import), where the value form would read an uninitialized parent. The child's runtime `path` is only `path` (its type is still the full path). When its router is mounted under the parent's router, `meta.path` is still the full path. Not deprecated.

## `RouteContext<TPath, TVars>`

```ts
interface RouteContext<TPath extends string, TVars extends object> {
  path: TPath;
  vars: TVars;
  middlewares: MiddlewareHandler[];
  middleware: MiddlewareFactory<TPath, TVars>;
  readonly segment?: string; // internal
}
```

- `path` — the literal path string carried at the type level.
- `vars` — a phantom value of the accumulated variables; useful only for type inspection.
- `middlewares` — the runtime list of middlewares applied by `makeRouter`.
- `segment` — internal. The path relative to the parent, used by `makeRouter` as the router's base path so that mounting does not prefix the parent path twice. When absent, `makeRouter` uses `path`.
- `middleware<NewVars>(handler)` — returns a new context with `handler` appended and `NewVars` merged into `TVars`. `NewVars` is constrained so that a key already in `TVars` maps to `"Cannot redeclare existing var: <key>"`: redeclaring fails on the type argument with a single error, and the handler keeps its contextual types. Without a type argument, `NewVars` defaults to `{}` (or is inferred from a pre-typed handler).

## `ContextEnv<TContext, TNewVars>`

```ts
type ContextEnv<TContext extends { path: string; vars: object }, TNewVars extends object = {}> = {
  Variables: TContext['vars'] & TNewVars;
};
```

The Hono `Env` of a middleware that runs on `TContext` and sets `TNewVars`. Give it to `createMiddleware` from `hono/factory`. The middleware then reads the vars of the context and sets the new vars, all typed:

```ts
const loadTenant = createMiddleware<ContextEnv<typeof apiRoute, { tenantId: string }>>(
  async (c, next) => {
    c.set('tenantId', `tenant-of-${c.var.session.userId}`);
    await next();
  },
);
const tenantRoute = apiRoute.middleware<{ tenantId: string }>(loadTenant);
```

Hono's `Context` type must match `Variables` exactly. So a middleware fits only contexts whose vars are equal to `TContext['vars']`. On a context without vars, `createMiddleware<{ Variables: TNewVars }>` also fits.

## `createRouter(options?)`

```ts
function createRouter<const TBase extends BaseRouteConfig = {}>(
  options?: CreateRouterOptions<TBase>,
): MakeRouterFn<TBase>;

interface CreateRouterOptions<TBase extends BaseRouteConfig = {}> {
  routeMiddleware?: RouteMiddlewareFactory | RouteMiddlewareFactory[];
  routeDefaults?: TBase;
  /** @deprecated Use `routeDefaults`. */
  base?: TBase;
  transformRoute?: (config: RouteConfig, meta: RouteHookMeta) => RouteConfig;
}

type BaseRouteConfig = Partial<Omit<RouteConfig, 'method' | 'path'>>;
type RouteMiddlewareFactory = (route: RouteConfig, meta: RouteHookMeta) => MiddlewareHandler;

interface RouteHookMeta {
  readonly path: string;
}
```

Returns a `makeRouter`. Options:

- **`routeMiddleware`** — factories invoked once **at route declaration time** with the resolved `RouteConfig` (the `createRoute()` output) and a `RouteHookMeta`. The returned middlewares are attached to the route's exact method + path (`router.on(method, path)`), so other methods on the same path are unaffected; HEAD requests run a GET route's middlewares. When an array is supplied, middlewares run in array order. Each middleware can call `next()` to continue or return a `Response` to short-circuit — Hono's standard middleware contract. `RouteMiddlewareFactory` returns an untyped `MiddlewareHandler`, so a factory that returns `createMiddleware<{ Variables: { session: Session } }>(...)` type-checks even when no middleware sets `session`: the library does not check the vars that a factory's middleware reads.

- **`routeDefaults`** — a partial `RouteConfig` deep-merged into every route declared via this router. Pipeline order: `routeDefaults` ⊕ per-route config → `createRoute()` → `meta` computed → `transformRoute` → `routeMiddleware` factories → returned to caller. Merge rules:
  - **Plain objects** recurse key-by-key (e.g. `responses[200]`, `request.params`).
  - **Arrays** are concatenated and structurally deduplicated (e.g. `security`, `tags`). Exception: a route `security: []` replaces `routeDefaults.security`, so the route opts out of it (OpenAPI semantics). Other empty arrays, such as `tags: []`, are still additive.
  - **Zod schemas** at the same merge position are unioned via `baseSchema.or(routeSchema)`. Useful when both `routeDefaults` and the route declare e.g. `responses[422]` with different validation-error shapes.
  - **All other leaf conflicts** are won by the per-route value.

  The merged shape is reflected in the static return type of `defineRoute()`, so handlers see the combined `responses`/`request` (with `ZodUnion<readonly [default, route]>` at colliding schema slots).

- **`base`** — deprecated name of `routeDefaults`, removed in 2.0. It infers and merges the same way. If both are set, `routeDefaults` is used and `base` is ignored.

- **`transformRoute`** — a runtime-only `(config, meta) => RouteConfig` hook applied immediately after `createRoute()` (and after the `routeDefaults` merge), before `routeMiddleware` factories receive the config and before it is returned to the caller. The static return type of `defineRoute()` is **not** affected by this hook; it is an escape hatch for cross-cutting mutations (auto-tagging, injecting `operationId`, normalizing security entries, etc.).

- **`RouteHookMeta`** — the second argument of `routeMiddleware` factories and `transformRoute`. `meta.path` is the router's full mount path joined with the route's relative path (`'/'` gives the mount path; a root defined as `''` gives `'/'`), in Hono `:param` syntax. It is computed before `transformRoute` and does not change if the hook rewrites `config.path`. A mounted router always gets the full URL path in `meta.path`. Its parent passes its own full path, and the router joins it with its segment. This is true for value-form children, curried children, and value-form children of a curried parent. A thunk called directly, with no parent, uses its context's runtime `path`. That is the full path for a root. For a value-form child, it is the full path only when every ancestor is a root or a value-form child. A value-form child with a curried ancestor gets a partial path that starts at that ancestor's segment (for example `/things/sub`). A curried child gets only its segment. `config.path` itself stays relative (usually `'/'`).

## `BaseRouteConfig` and `DeepMerge<A, B>`

```ts
type BaseRouteConfig = Partial<Omit<RouteConfig, 'method' | 'path'>>;
type DeepMerge<A, B> = /* see source */;
```

Exported as type-only helpers. `DeepMerge` is the type-level equivalent of the runtime merge:

- it produces `ZodUnion<readonly [A, B]>` when both sides are `ZodType`;
- it merges two arrays into an element union, `(A[number] | B[number])[]`. It does not produce a tuple, because the runtime deduplicates;
- it recurses through plain objects. When the route type of a key includes `undefined`, the result also includes the base type and `undefined`, because the runtime keeps the base value for an absent key and copies an explicit `undefined`;
- otherwise the second argument wins.

Known limitation: optional (`?`) modifiers are not kept through the merge. When `routeDefaults` has no keys, `defineRoute()` returns the route config type unchanged. Use `DeepMerge` to type external wrappers that build configs from the same `routeDefaults`.

## `makeRouter(context, factory, children?)`

```ts
type ChildRouterThunk = () => OpenAPIHono<any, any, any>;

// Without children: the factory may return anything.
function makeRouter<TPath, TVars, TFactoryResult>(
  context: RouteContext<TPath, TVars>,
  factory: (options: {
    router: OpenAPIHono<{ Variables: TVars }>;
    defineRoute: MakeRouteFn<TPath, TBase>;
    /** @deprecated Use defineRoute. Removed in 2.0. */
    route: MakeRouteFn<TPath, TBase>;
  }) => TFactoryResult | void,
): () => FactoryReturn<TFactoryResult, OpenAPIHono<{ Variables: TVars }>>;

// With children: the factory returns a router or nothing.
function makeRouter<
  TPath,
  TVars,
  TFactoryResult extends OpenAPIHono<any, any, any> | void,
  const TChildren extends readonly ChildRouterThunk[] = [],
>(
  context: RouteContext<TPath, TVars>,
  factory: (options: {
    router: OpenAPIHono<{ Variables: TVars }>;
    defineRoute: MakeRouteFn<TPath, TBase>;
    /** @deprecated Use defineRoute. Removed in 2.0. */
    route: MakeRouteFn<TPath, TBase>;
  }) => TFactoryResult,
  children?: TChildren,
): () => WithChildSchemas<
  FactoryReturn<TFactoryResult, OpenAPIHono<{ Variables: TVars }>>,
  ChildSchema<TChildren[number]>
>;
```

`ChildRouterThunk`, `WithChildSchemas` and `ChildSchema` are internal names (see
`src/router/types.ts`); they are not exported.

If the factory returns nothing (or `null`/`undefined` on some path), the thunk
returns the router itself; children are still mounted on it. When `children` are
passed, the factory must return a router or nothing.

The built app's type includes the children's routes, so `hc` and `testClient` see
them. Pass `children` inline or `as const`: an array held in an annotated variable
(for example `(() => OpenAPIHono<any, any, any>)[]`) widens and drops the schemas.
If two children declare the same method and path, the client type for that path becomes
`never` or a false merge of the two bodies, because the schemas are intersected (as in
Hono's `route()`). Declare each method and path once.

`TBase` is threaded from `createRouter`'s options, so `defineRoute()`'s return type reflects the configured `routeDefaults`.

The router's base path is `context.segment ?? context.path`: the context's path relative to its parent.

Returns a **thunk** that, when invoked, builds and returns the router. The deferred invocation allows children to be mounted by a parent without ordering issues. Its public type takes no arguments, so call it as `thunk()`. At runtime a parent calls each child thunk with an internal argument that holds the parent's full mount path; the child uses it only to compute `meta.path`. A thunk called with no argument (directly, or wrapped as `() => thunk()` in `children`) uses its context's runtime `path` for `meta.path`, as described under `RouteHookMeta`. Routing is the same in both cases.

The same internal argument also identifies the parent's context. A value-form child's thunk can be mounted under the context that it was defined from, or under a `.middleware()` descendant of that context. Under any other context, the thunk throws an `Error` (`makeRouter: the child context '…' was defined under the context at '…', but its router is mounted under …`). Without this check, a child defined under an auth-protected parent and mounted under another parent would serve its routes without the parent's middlewares. A `.middleware()` descendant runs all of the parent's middlewares plus its own, so mounting under it is allowed. Curried children, thunks called directly, and thunks wrapped as `() => thunk()` are not checked.

The `defineRoute(method, config)` argument supplied to `factory` (`route` is a deprecated alias that holds the same function):

- Calls `createRoute({ method, path: '/', ...config })` so that the route is registered at the context's base path.
- If `createRouter` was given `routeMiddleware`, calls each factory with the config and its `RouteHookMeta`, and attaches the resulting middleware(s) to this route's method + path.
- Returns the resolved `RouteConfig` for use with `router.openapi(config, handler)`.

## `createScopeMiddleware(options)` _(from `hono-typed-router/scopes`)_

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
jsonResponse(schema, description); // { description, content: { 'application/json': { schema } } }
jsonBody(schema, description); // same shape, for request bodies
jsonRequest(schema, description); // { body: { ...jsonBody(...), required: true } }
emptyResponse(description); // { description }
```

These are thin shape-builders for `@hono/zod-openapi` `createRoute()` configs. The 0.x names `makeHonoResponse`, `makeHonoJsonBody`, `makeHonoJsonRequest` and `makeHonoNoContentResponse` are deprecated aliases of these four (removed in 2.0).

## Error handling

### `handle(c, fn, arms?)`

```ts
function handle<I extends Input, R, const A extends ReadonlyArray<AnyArm> = readonly []>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<R>,
  arms?: A,
): Promise<R | ArmsResponse<A>>;

type ValidatedProxy<I extends Input> = {
  [K in keyof ValidationTargets]: InputToDataByTarget<I['out'], K>;
};
```

Runs a route handler body and returns a plain promise. `fn` receives a `ValidatedProxy` — a destructurable view over the request's validated inputs (`param`, `query`, `json`, `form`, `header`, `cookie`), each typed from the route's `Input`. Every target is read from `c.req.valid` **lazily and cached**: untouched targets are never read, and a touched target is read once.

With `arms`, a thrown `Error` is dispatched through `handleErrors` and the result type is widened with each arm's response (`ArmsResponse<A>`). Because that widened value is what you return to `router.openapi(...)`, **an arm that emits a status the route did not declare in `responses` is a compile error**. Without `arms`, the return type is exactly `Promise<R>` and a thrown error rejects the promise.

### `handler(c, fn)` _(deprecated)_

```ts
function handler<I extends Input, TResponse>(
  c: Context<any, any, I>,
  fn: (proxy: ValidatedProxy<I>) => Promise<TResponse>,
): HandlerInvocation<TResponse>;
```

Deprecated, removed in 2.0: use `handle(c, fn)` or `handle(c, fn, arms)`. Returns a lazy thenable over `handle(c, fn)`. The body runs at most once, whether awaited directly or via `.errors([...])`, in any order.

### `HandlerInvocation<TResponse>` _(deprecated)_

```ts
type HandlerInvocation<TResponse> = Promise<TResponse> &
  Readonly<{
    errors: <const TArms extends ReadonlyArray<AnyArm>>(
      arms: TArms,
    ) => Promise<TResponse | ArmsResponse<TArms>>;
  }>;
```

Awaitable result of the deprecated `handler`. On its own it settles to `TResponse`. Calling `.errors(arms)` runs the body under `handleErrors` and widens the result with each arm's response type. Because that widened value is what you return to `router.openapi(...)`, **an arm that emits a status the route did not declare in `responses` is a compile error** — the OpenAPI contract and the runtime handler cannot drift apart.

### `onError(ctor, handle)`

```ts
function onError<TErr extends Error, TResult>(
  ctor: new (...args: any[]) => TErr,
  handle: (err: TErr, c: Context) => TResult | Rethrow | Promise<TResult | Rethrow>,
): ErrorArm<TErr, TResult>;
```

Declares an **error arm**: match errors that are `instanceof ctor`, then run `handle`. `TResult` is inferred from the handler's return, so the arm carries the exact response type it produces (e.g. `c.json(body, status)`'s `TypedResponse`). Return `rethrow()` to decline and fall through to the next arm.

`on` is the deprecated 0.x name of `onError` (removed in 2.0).

### `matchErrors(errors, handlers)`

```ts
type ErrorCtor = new (...args: any[]) => Error;

// The string-literal `_tag` of the class's instances, else their string-literal `name`, else never.
type ErrorTag<C extends ErrorCtor> = /* ... */;

type MatchHandlers<TCtors extends readonly ErrorCtor[]> = {
  readonly [C in TCtors[number] as ErrorTag<C>]: (err: InstanceType<C>, c: Context) => any;
};

function matchErrors<
  const TCtors extends readonly ErrorCtor[],
  THandlers extends MatchHandlers<TCtors> /* & no keys outside the tags */,
>(
  errors: TCtors, // each class must have a unique literal tag
  handlers: THandlers,
): { readonly [I in keyof TCtors]: ErrorArm<InstanceType<TCtors[I]>, /* handler's response */> };
```

Declares one error arm per class, with an exhaustive handler map keyed by tag. It returns an arm tuple, so it goes where an arm list goes: `handle(c, fn, matchErrors(...))`, `handleErrors(body, matchErrors(...), c)`, or spread next to other arms: `[...matchErrors(...), onError(Error, ...)]`. Each element has the same type as the equivalent `onError(Class, handler)` arm, so the return type of `handle` is the same, and **a handler that emits a status the route did not declare is a compile error** inside `router.openapi`.

```ts
class CartNotFound extends Error {
  readonly _tag = 'CartNotFound' as const;
}

class OutOfStock extends Error {
  readonly _tag = 'OutOfStock' as const;
  constructor(readonly sku: string) {
    super();
  }
}

class Legacy extends Error {
  override readonly name = 'Legacy' as const;
}

router.openapi(checkout, (c) =>
  handle(
    c,
    async ({ param }) => c.json(await checkoutCart(param.id), 201),
    matchErrors([CartNotFound, OutOfStock, Legacy], {
      CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
      OutOfStock: (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
      Legacy: () => rethrow(),
    }),
  ),
);
```

**Keys.** The key of a class is `ErrorTag<Class>`:

1. the string-literal type of its instances' `_tag`, if there is one;
2. else the string-literal type of their `name`. Declare it as `override readonly name = 'X' as const`. A `name` typed `string` (as `Error.prototype.name` is, including `this.name = 'X'` in a constructor) does not count;
3. else the class is rejected in the `errors` list with `Error class at index N needs a literal _tag or name`.

Two classes with the same tag are also rejected (`Error class at index N shares the tag "X" with another class`).

**Exhaustive.** `handlers` must have a key for every class, and no other key. A missing key is reported as a missing property; an extra key as a value not assignable to `never`. Each handler receives the instance of its own class (`e.sku` above) and the `Context`, and returns a response or `rethrow()`, sync or async, as in `onError`.

**Dispatch.** A thrown `Error` that is an instance of **any** listed class (by `instanceof`) is handled by the handler keyed by its runtime tag: its `_tag` if `handlers` has that key, else its `name`. **List order does not matter**: the class list only decides whether the tuple handles the error, and the tag picks the handler. An unlisted subclass that inherits a listed class's tag goes to that class's handler. A `rethrow()` passes the error to the arms after the tuple. Non-`Error` throws bypass the arms.

**Hazard: reused tags.** TypeScript rejects a subclass that changes an inherited literal `_tag` or `name`, but not a subclass of a `name`-tagged class that _adds_ a `_tag`. If that `_tag` equals another listed class's tag, the error goes to that other class's handler, whose parameter is typed as that class although the error is not an instance of it. Do not reuse a tag across unrelated classes.

**Rethrow.** A handler that returns `rethrow()` passes the error past the rest of the tuple to the next arm after it (for example an `onError(Error, ...)` spread after it). If no arm handles it, the original error is rethrown.

If the error is an instance of a listed class but neither its `_tag` nor its `name` names a handler (for example a `_tag` declared with `declare` and never set), the arm passes as if it returned `rethrow()`: a later arm can handle the error, and otherwise the original error is rethrown. An error thrown inside a handler propagates as is and skips the later arms.

`onError` is the primitive `matchErrors` is built on. Use it directly for a single arm, for arms shared across routes, or to match a class that has no literal tag.

### `rethrow()` / `RETHROW`

```ts
const RETHROW: unique symbol;
type Rethrow = typeof RETHROW;
function rethrow(): Rethrow;
```

`rethrow()` returns the `RETHROW` sentinel (compared by identity). An arm returning it defers to the next matching arm; if none matches, the original error is rethrown. `Rethrow` responses never leak into the widened return type.

### `handleErrors(body, arms, c)`

```ts
function handleErrors<TBody, const TArms extends ReadonlyArray<AnyArm>>(
  body: () => Promise<TBody>,
  arms: TArms,
  c: Context,
): Promise<TBody | ArmsResponse<TArms>>;
```

`ArmsResponse<TArms>` is the union of each arm's awaited response minus the
`Rethrow` sentinel. It is the same type `handle(c, fn, arms)` widens with.

The dispatch behind `handle(c, fn, arms)`, usable on its own when you don't need the input proxy. Runs `body()`; if it throws an `Error`, the first arm whose `ctor` matches (by `instanceof`) handles it, arms are tried in order, and an arm returning `rethrow()` falls through. Non-`Error` throws bypass the arms. The return type is `TBody` widened with each arm's response (awaited, minus the `Rethrow` sentinel).

### `genericErrorHandler(status)`

```ts
function genericErrorHandler<T extends ContentfulStatusCode>(
  statusCode: T,
): (err: Error, c: Context) => TypedResponse<{ message: string }, T, 'json'>;
```

Convenience arm handler that responds with `{ message: err.message }` at the given status. Compose with `onError`: `onError(SomeError, genericErrorHandler(409))`.

## Extending the `define[x]` context

### `extendRouteContext<K>(builders)`

```ts
function extendRouteContext<K extends RouteContextKind>(
  builders: ExtensionBuilders<K>,
): ExtendRouteContextResult<K>;

interface ExtendRouteContextResult<K extends RouteContextKind> {
  defineRootRoute: <TPath extends string, TVars extends object = {}>(
    path: TPath,
    middlewares?: MiddlewareHandler<{ Variables: TVars }>[],
  ) => ReaugmentContext<K, TPath, TVars>;
  defineChildRoute: {
    // Value form
    <TPath extends string, TParentPath extends string, TParentVars extends object>(
      parent: { path: TParentPath; vars: TParentVars },
      path: TPath,
    ): ReaugmentContext<K, `${TParentPath}${TPath}`, TParentVars>;
    // Curried form
    <TParentContext extends { path: string; vars: object }>(): <TPath extends string>(
      path: TPath,
    ) => ReaugmentContext<K, `${TParentContext['path']}${TPath}`, TParentContext['vars']>;
  };
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
  middleware: <TNewVars extends NoRedeclare<TNewVars, TVars> = {}>(
    handler: MiddlewareHandler<{ Variables: TVars & TNewVars }, TPath>,
  ) => ReaugmentContext<K, TPath, TVars & TNewVars>;
}

// The custom builder names a kind adds on top of RouteContextBase.
type ExtensionNames<K extends RouteContextKind>;

// The runtime builders map: { [name]: (ctx) => (...args) => Context }. Each builder's
// parameters are typed from your interface's method (at a loose `string` path and
// `object` vars, so a `ParamKeys<TPath>` param is `never`) and it must return a
// context, typically `ctx.middleware(mw)`. No cast is needed.
type ExtensionBuilders<K extends RouteContextKind>;
```

A full worked example (with `bindRepository`, `ParamKeys`, and the redeclaration guard) is in the README under _Extending the `define[x]` context_ and in `docs/usage.md`.

Known display quirk: on an extended context, the vars added by `.middleware<{ s: 1 }>()` display as `object & { s: 1 }` in editor hovers. The `object` comes from the `this['vars'] & object` slot of the `RouteContextKind` pattern. The type is assignable both ways, but an exact-equality check such as `expectTypeOf(ctx.vars).toEqualTypeOf<{ s: 1 }>()` fails; use `toMatchTypeOf`.
