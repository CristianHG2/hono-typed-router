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

## What this package deliberately omits

- **Domain coupling.** No repository binding, no scope enum, no auth glue. The HR Papa codebase that this was extracted from binds repositories to params and checks against a `Scope` union; both are 10-line userland wrappers (see the README recipes).
- **A generic "validate this before/after the handler" lifecycle.** That's `routeMiddleware`'s job. If a use case can be expressed as Hono middleware, it should be.
- **Catch-all error mapping.** Hono's `app.onError` already handles that.

## Open questions / future work

- Tightening the `children?: (() => OpenAPIHono<any, any, any>)[]` typing so the child's type can be cross-checked against the parent. Currently the trade-off is "broad inference everywhere else" vs. "exact child typing" — the broad inference won.
- A `routeMiddleware` factory entry that has access to the *resolved* path (with parent base paths prepended) rather than just the local `/`. Today it sees `route.path === '/'` because the path lives on the router instance, not the route config. Surfacing the full path would require recording the basePath on the router instance for later lookup. Not currently needed.
