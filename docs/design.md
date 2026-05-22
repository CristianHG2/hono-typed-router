# Design notes

## Why a separate router builder?

`@hono/zod-openapi` already provides a typed `createRoute` + `openapi()` integration. What it does *not* provide:

1. **Path types that flow through nested routers.** With raw Hono, each sub-app is its own type universe; you can't statically express "a child route under `/organizations/:id` inherits both the path *and* the parent's middleware-set variables."
2. **A type-safe place to attach context variables.** Hono lets you `.use(middleware)`, but tracking which variables are added by which middleware — and refusing to silently overwrite an existing var — is hand-rolled.
3. **A single place to attach cross-cutting per-route policy.** Scope checks, request logging, audit hooks: in raw Hono these end up sprinkled across handlers or hidden in `.use('*')` middleware that has to re-parse the request to know which route it matched.

This package gives you those three things and stays out of your way for everything else.

## `RouteContext` — what is it?

`RouteContext<TPath, TVars>` is a small immutable value that pairs:

- a **path literal** (`TPath`) — the string the router will be mounted at, carried at the type level so child paths can concatenate it,
- a **vars phantom** (`TVars`) — the accumulated map of variables set on `c.var` by all middleware applied to this context,
- the **runtime middleware list** that `makeRouter` will install.

The constructor is private; you get a `RouteContext` only via `defineRootRoute` or `defineChildRoute`, both of which preserve `TPath` and `TVars` precisely.

`.middleware<NewVars>(handler)` returns a new context with `NewVars` merged into `TVars`. The handler's signature is constrained to `MiddlewareHandler<{ Variables: TVars & NewVars }, TPath>` — i.e., the handler sees what's already in `c.var` *and* can set the new vars. Redeclaration is blocked by a conditional type: if `keyof NewVars & keyof TVars` is non-empty, the handler type collapses to a string template literal, which the call site can't satisfy.

## `createRouter` factory + `routeMiddleware`

The hook lives at the **factory** level rather than per-`makeRouter`-call because every router in an app generally wants the same policy stack. Threading it per-call would re-create the coupling we're trying to remove.

The hook shape — `(route: RouteConfig) => MiddlewareHandler` — is curried for two reasons:

- **Per-route work happens once.** A scope-check factory can precompute the required scopes by reading `route.security` once at declaration, instead of on every request.
- **The returned value is a vanilla Hono middleware.** No new contract to learn; `next()`, returning a `Response`, throwing — all behave as they would anywhere else in Hono.

Each route's middleware is registered via `router.use(declaredRoute.path, gateByMethod(method, mw))`. The method gate is necessary because Hono's `use(path, mw)` matches a path, not a method.

## `base` — a shared RouteConfig fragment

`base` exists for the same reason `routeMiddleware` does: there are concerns every route shares (a standard set of error response shapes, a global `security` requirement, a `tags` prefix) and there is no good place to put them today other than copy-paste or a userland wrapper around `createRoute`.

The deep-merge semantics were chosen to make `base` *additive* in the cases that matter:

- **Plain objects recurse** so adding `responses: { 401: ... }` in `base` does not nuke the per-route `responses: { 200: ... }`.
- **Arrays concat + dedupe** so `tags` and `security` accumulate across base and route. OpenAPI semantics for `security` are "any of"; dedupe just keeps the list clean.
- **Zod schemas at the same slot are unioned via `.or()`.** This is the load-bearing rule for the validation-error case: both `base` (project-wide 422) and a route (route-specific 422) commonly define a schema, and the right semantic is "the response can be either shape," not "the route silently drops the base contract." The type-level result is `ZodUnion<readonly [Base, Route]>`, so the handler is forced to satisfy the discriminated union.
- **Everything else: route wins.** Per-route `description`, `summary`, scalar overrides — the route is authoritative.

The merged shape is reflected statically (via `DeepMerge<TBase, TRouteConfig>`), so `router.openapi(declared, handler)` rejects handlers that don't satisfy the *combined* contract.

Trade-off: detecting "is this a zod schema" relies on a `_def` brand at both the type and runtime levels. That couples the library to zod's internal shape, but zod is already a hard peer dep via `@hono/zod-openapi`, so the coupling is honest.

## `transformRoute` — runtime escape hatch

`transformRoute` is intentionally **runtime-only** (no type effect). Use cases like "always derive `operationId` from `method` + `path`" or "tag every route with the deploy stage" are real, but encoding them at the type level would require either a brittle template-literal type or asking the user to declare the transform's effect twice (once at the value, once at the type). Neither was worth it for ergonomics.

The hook runs *after* the `base` merge and *before* `routeMiddleware` factories. That ordering means:
- The transformer sees the fully-resolved config (with `base` applied), so it can derive metadata from the final shape.
- `routeMiddleware` factories — which often precompute scope sets or audit metadata from the route — see the transformed config, so derived fields like `operationId` are observable to them.
- The caller of `route()` receives the transformed config, so the value handed to `router.openapi(declared, handler)` reflects the runtime truth.

## What this package deliberately omits

- **Domain coupling.** No repository binding, no scope enum, no auth glue. The HR Papa codebase that this was extracted from binds repositories to params and checks against a `Scope` union; both are 10-line userland wrappers (see the README recipes).
- **A generic "validate this before/after the handler" lifecycle.** That's `routeMiddleware`'s job. If a use case can be expressed as Hono middleware, it should be.
- **Catch-all error mapping.** Hono's `app.onError` already handles that.

## Open questions / future work

- Tightening the `children?: (() => OpenAPIHono<any, any, any>)[]` typing so the child's type can be cross-checked against the parent. Currently the trade-off is "broad inference everywhere else" vs. "exact child typing" — the broad inference won.
- A `routeMiddleware` factory entry that has access to the *resolved* path (with parent base paths prepended) rather than just the local `/`. Today it sees `route.path === '/'` because the path lives on the router instance, not the route config. Surfacing the full path would require recording the basePath on the router instance for later lookup. Not currently needed.
