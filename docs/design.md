# Design notes

## Why a separate router builder?

`@hono/zod-openapi` already provides a typed `createRoute` + `openapi()` integration. What it does _not_ provide:

1. **Path types that flow through nested routers.** With raw Hono, each sub-app is its own type universe; you can't statically express "a child route under `/organizations/:id` inherits both the path _and_ the parent's middleware-set variables."
2. **A type-safe place to attach context variables.** Hono lets you `.use(middleware)`, but tracking which variables are added by which middleware — and refusing to silently overwrite an existing var — is hand-rolled.
3. **A single place to attach cross-cutting per-route policy.** Scope checks, request logging, audit hooks: in raw Hono these end up sprinkled across handlers or hidden in `.use('*')` middleware that has to re-parse the request to know which route it matched.

This package gives you those three things and stays out of your way for everything else.

## `RouteContext` — what is it?

`RouteContext<TPath, TVars>` is a small immutable value that pairs:

- a **path literal** (`TPath`) — the string the router will be mounted at, carried at the type level so child paths can concatenate it,
- a **vars phantom** (`TVars`) — the accumulated map of variables set on `c.var` by all middleware applied to this context,
- the **runtime middleware list** that `makeRouter` will install.

The constructor is private; you get a `RouteContext` only via `defineRootRoute` or `defineChildRoute`, both of which preserve `TPath` and `TVars` precisely.

### Two forms of `defineChildRoute`

`defineChildRoute(parent, segment)` (the value form) infers everything from the parent value, and its runtime `path` is `parent.path` joined with `segment` by `/`, which is the full path when every ancestor is a root or a value-form child. The router built from it must still be mounted under the parent's router, which adds the parent's part of the path, so the context also carries the relative `segment` and `makeRouter` uses that as the router's base path. Without that split a mounted value-form child would be served at `/api/api/things`.

`defineChildRoute<typeof parent>()(segment)` (the curried form) takes the parent as a type only. It stays, and is not deprecated, because the file-per-route layout has circular imports: a parent module imports its children's routers to mount them, and each child imports its parent's context. With the curried form that import can be `import type`, so there is no runtime cycle. The value form reads the parent value at module load, which a cycle does not provide. A curried child's runtime `path` is only its segment; its type is the full path.

Neither form copies the parent's middlewares into the child. Mounting the child's router under the parent's router runs them, and copying would run them twice.

`.middleware<NewVars>(handler)` returns a new context with `NewVars` merged into `TVars`. The handler's signature is constrained to `MiddlewareHandler<{ Variables: TVars & NewVars }, TPath>` — i.e., the handler sees what's already in `c.var` _and_ can set the new vars. Redeclaration is blocked by a constraint on the type argument (`NewVars extends NoRedeclare<NewVars, TVars>`): each key already in `TVars` must be the string `"Cannot redeclare existing var: <key>"`, so `.middleware<{ existing: X }>()` fails once on the type argument and the handler keeps its contextual types.

## `createRouter` factory + `routeMiddleware`

The hook lives at the **factory** level rather than per-`makeRouter`-call because every router in an app generally wants the same policy stack. Threading it per-call would re-create the coupling we're trying to remove.

The hook shape — `(route: RouteConfig, meta: RouteHookMeta) => MiddlewareHandler` — is curried for two reasons:

- **Per-route work happens once.** A scope-check factory can precompute the required scopes by reading `route.security` once at declaration, instead of on every request.
- **The returned value is a vanilla Hono middleware.** No new contract to learn; `next()`, returning a `Response`, throwing — all behave as they would anywhere else in Hono.

Each route's middlewares are registered via `router.on(METHOD, path, ...mws)`, with the OpenAPI `{param}` path converted to Hono's `:param` the same way `@hono/zod-openapi` does. Using `on` (not `use(path)` plus a method check) means the middlewares match exactly the requests the route's handler matches, including HEAD requests, which Hono serves through the GET handlers.

## `routeDefaults` — a shared RouteConfig fragment

`routeDefaults` (named `base` in 0.x; that name is a deprecated alias) exists for the same reason `routeMiddleware` does: there are concerns every route shares (a standard set of error response shapes, a global `security` requirement, a `tags` prefix) and there is no good place to put them today other than copy-paste or a userland wrapper around `createRoute`.

The deep-merge semantics were chosen to make `routeDefaults` _additive_ in the cases that matter:

- **Plain objects recurse** so adding `responses: { 401: ... }` in `routeDefaults` does not nuke the per-route `responses: { 200: ... }`.
- **Arrays concat + dedupe** so `tags` and `security` accumulate across the defaults and the route. OpenAPI semantics for `security` are "any of"; dedupe just keeps the list clean.
- **`security: []` on a route replaces the default `security`.** In OpenAPI an operation-level empty `security` removes the inherited requirement, so a route that writes `[]` means "public". The rule applies to `security` only: a generic "empty array replaces" rule would make `tags: []` silently drop the default tags.
- **Zod schemas at the same slot are unioned via `.or()`.** This is the load-bearing rule for the validation-error case: both `routeDefaults` (project-wide 422) and a route (route-specific 422) commonly define a schema, and the right semantic is "the response can be either shape," not "the route silently drops the default contract." The type-level result is `ZodUnion<readonly [Base, Route]>`, so the handler is forced to satisfy the discriminated union.
- **Everything else: route wins.** Per-route `description`, `summary`, scalar overrides — the route is authoritative.

The merged shape is reflected statically (via `DeepMerge<TBase, TRouteConfig>`), so `router.openapi(declared, handler)` rejects handlers that don't satisfy the _combined_ contract. The type follows the runtime rules exactly where they are observable: merged arrays are typed `(Base[number] | Route[number])[]` rather than a concatenated tuple (dedupe makes the length unknowable), and a route key that may be `undefined` widens to `Base | Merged | undefined` (an explicit `undefined` is copied over the base value). One known gap: optional (`?`) modifiers are not preserved through the merge.

Trade-off: detecting "is this a zod schema" relies on a `_def` brand at both the type and runtime levels. That couples the library to zod's internal shape, but zod is already a hard peer dep via `@hono/zod-openapi`, so the coupling is honest.

## `transformRoute` — runtime escape hatch

`transformRoute` is intentionally **runtime-only** (no type effect). Use cases like "always derive `operationId` from the method and `meta.path`" or "tag every route with the deploy stage" are real, but encoding them at the type level would require either a brittle template-literal type or asking the user to declare the transform's effect twice (once at the value, once at the type). Neither was worth it for ergonomics.

The hook runs _after_ the `routeDefaults` merge and _before_ `routeMiddleware` factories. That ordering means:

- The transformer sees the fully-resolved config (with `routeDefaults` applied), so it can derive metadata from the final shape.
- `routeMiddleware` factories — which often precompute scope sets or audit metadata from the route — see the transformed config, so derived fields like `operationId` are observable to them.
- The caller of `defineRoute()` receives the transformed config, so the value handed to `router.openapi(declared, handler)` reflects the runtime truth.

### `meta.path`

Both hooks get a second argument, `meta: RouteHookMeta`. `meta.path` is the router's full mount path joined with the route's relative path. The config's own `path` stays relative (usually `'/'`), because it is registered on a router whose base path already holds the context's segment: putting the full path on the config would register the route at a doubled path. `meta.path` is computed once, before `transformRoute`, so a hook that rewrites `config.path` does not change what the factories see in `meta`.

The mount path cannot come from the context alone: a curried child's runtime path is only its segment, because its parent is a type-only import. So the mount path is passed down through the thunks. A parent calls each child thunk with an internal `{ basePath, lineage }` argument. `basePath` holds the parent's own full path, and the child joins it with its segment (with the same `joinChildPath` as `defineChildRoute`). The mount guard (below) uses `lineage`. That is where Hono serves the child, whatever form defined its context, so one rule covers curried children, value-form children and a value-form child of a curried parent. The argument is not in the public thunk type, which stays `() => ...`: a thunk is still called as `thunk()`, and `ChildRouterThunk` and the children's schema inference do not change. Mounted, `meta.path` is therefore always the full path. A thunk called with no argument has no parent to ask, so it falls back to its context's runtime `path`. This occurs when you call it directly or wrap it in another function. That is the full path for a root, and for a value-form child only when every ancestor is a root or a value-form child. A value-form child with a curried ancestor gets a partial path that starts at that ancestor's segment, and a curried child gets only its segment. The router's own base path is still the segment; only `meta.path` uses the mount path.

### Mount guard

A child context does not copy its parent's middlewares: the parent's router runs them because the child's router is mounted under it. So a value-form child defined under an auth-protected parent and mounted under a different parent type-checks (the vars are only a type) and serves its routes without the auth middleware. `makeRouter` checks this at runtime.

Every context that `createRouteContext` builds gets an internal identity: a unique `id` (a `Symbol`) and a `lineage`. A value-form child also records the `parentId` and `parentPath` of the exact context passed as `parent`. The `lineage` is the list of ids of the context and of the contexts it was derived from with `.middleware()`, ending with its own `id`. Roots and value-form children start a new lineage. A `.middleware()` call returns a new context, so it gets a new `id`, appends it to its source's lineage, and keeps its `parentId`. The identity is stored under a module-private symbol key, not in the public `RouteContext` type: an object spread (as in `extendRouteContext`'s `augment`) copies it, and `Object.keys` and `JSON.stringify` do not show it. A WeakMap or a non-enumerable property would not survive that spread.

A parent thunk passes `{ basePath, lineage }` to each child thunk that it mounts. A child thunk with a `parentId` throws when the mount's `lineage` does not contain that `parentId`. So a child of `root` mounts under `root.middleware(a)` and under `root.middleware(a).middleware(b)`: those contexts run every middleware that the child's type assumes, plus more. A child of `root.middleware(a)` throws under `root` (an ancestor) and under `root.middleware(c)` (a sibling branch): both lack `a`, which is the auth-bypass case. A value-form child starts a new lineage instead of extending its parent's lineage. Otherwise a child of `root` would pass the check under a sibling child of `root` and serve its routes under that sibling's path. Builders of `extendRouteContext` keep the lineage, because they return `.middleware()` results and `augment` copies the identity.

Not checked: curried children (their parent is a type-only import, so there is no parent value to record), a thunk called directly (no parent), a thunk wrapped as `() => thunk()` in `children` (the wrapper drops the mount argument), and a parent object that `defineRootRoute`/`defineChildRoute` did not build.

## Error handling — `handle` + `onError`/`handleErrors`

The value `handle(c, fn, arms)` adds is a **type-level bridge between the arms you wire and the responses the route declares**. `handleErrors` widens its return type with each arm's response (`ArmsResponse<TArms>`, i.e. `Exclude<Awaited<TResult>, symbol>` per arm), and that widened value is what `router.openapi(declared, handler)` type-checks against the route's `responses`. So an arm that emits a `409` the route never declared — or a body whose shape doesn't match — is a compile error, not a runtime surprise. The OpenAPI contract and the runtime error mapping are forced to agree.

A few deliberate details:

- **`Exclude<Awaited<TResult>, symbol>`, not `Exclude<TResult, Rethrow>`.** An arm that can `rethrow()` infers `TResult` including a `Promise<Rethrow>` branch; without the `Awaited`, the sentinel survives `Exclude` and leaks into the response union. An `async () => rethrow()` arm widens the sentinel to a bare `symbol`, so the whole primitive is excluded rather than the `Rethrow` literal.
- **The input proxy is lazy and cached.** `fn` sees `{ param, query, json, ... }` but each target is only pulled from `c.req.valid` when destructured, and only once. Untouched targets cost nothing.
- **Arms are positional, and the result is a plain promise.** The 0.x API was `handler(c, fn).errors([...])`: a thenable with a method. It needed memoization so that awaiting it and calling `.errors()` did not run the body twice, and its stack frames read `HandlerInvocation.then`. `handle(c, fn, arms?)` has none of that, and with no arms its type is exactly `Promise<R>`. The thenable stays as the deprecated `handler`, implemented on top of `handle`.
- **Arms are values, reused across routes.** `onError(Ctor, handler)` returns a plain `ErrorArm`. The domain-specific arms (`recordNotFoundArm`, `uniqueViolationArm`, …) are userland one-liners over `onError`; the library ships only the generic dispatch.
- **`matchErrors` takes the error union as a class list.** TypeScript does not track what a function throws (there is no `throws` clause, and a `catch` binding is `unknown`), so the union of errors a route maps cannot be inferred from the body. The caller states it once, as the class list, and the library derives the rest: one required handler key per class, each handler typed with its own class, and one arm per class so the result types the same way as the `onError` arms. The keys come from a literal `_tag`, or else a literal `name`, because that is the convention of better-result (`TaggedError`, `error.match({...})`) and Effect (`Data.TaggedError`, `catchTags`): classes written for those libraries work unchanged, and the keys read as the error names. Dispatch gates on `instanceof`, like `onError`: an error that is an instance of any listed class (including an unlisted subclass) is handled. The handler is then picked by the error's runtime tag (`_tag`, else `name`), so the order in the list does not matter. A class's tag is an instance field and cannot be read from the constructor without constructing it, so the key has to come from the thrown error. The cost: a subclass of a `name`-tagged class that adds a `_tag` equal to another listed class's tag goes to that other handler with the wrong parameter type. Do not reuse tags across unrelated classes.

## `extendRouteContext` — type-safe context augmentation

Binding a repository to a `:param` is common enough that hand-rolling the recursive "augment the context, re-augment after `.middleware()`" wrapper each time is a papercut. `extendRouteContext` owns that recursion so a consumer only declares the method signatures.

The design constraint that shaped the API: **the extended context must be an `interface`, not a mapped-type alias.** A fully auto-derived approach (map the extension set to methods, have each method's return re-derive the context) trips TypeScript's "excessively deep, possibly infinite" instantiation, because a type alias is expanded eagerly during instantiation while an interface stays a lazy reference — exactly how the base `RouteContext.middleware` chains without blowing up. So the consumer supplies a self-referential interface extending `RouteContextBase` plus a one-line `RouteContextKind` (a higher-kinded slot that lets `extendRouteContext` apply an unapplied two-parameter interface). In exchange, chaining is unbounded and every method threads path + vars with a redeclaration guard (in the key position) and the `ParamKeys` constraint.

## What this package deliberately omits

- **Domain coupling.** No repository _implementation_, no scope enum, no auth glue. `extendRouteContext` provides the _mechanism_ to add a `bindRepository`-style builder, and `onError`/`handleErrors` the mechanism to map domain errors to responses — but the actual repositories, error classes, and scope unions stay in userland (see the README recipes).
- **A generic "validate this before/after the handler" lifecycle.** That's `routeMiddleware`'s job. If a use case can be expressed as Hono middleware, it should be.
- **Catch-all error mapping.** Hono's `app.onError` already handles that.

## Open questions / future work

- Children typing. The schema part is done: `children` is a `const` type parameter, and the built app's `Schema` is the parent's schema intersected with each child's schema, so `hc` / `testClient` see the children's routes. It is an intersection, not a union, because a union fails with TS2589 (excessively deep) in `testClient(app)` with 500 children, while the intersection still type-checks. A value-form child is checked against its parent at runtime (see "Mount guard" above); a curried child is not checked. With `children`, the factory must return a router or nothing.
