# hono-typed-router

Path-typed router builder for [Hono](https://hono.dev) with composable middleware contexts and per-route policy hooks. Built on top of [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi).

- **Typed paths** — route paths flow through the type system; child routes inherit the parent's path *and* its accumulated context variables.
- **Composable contexts** — attach middleware via `.middleware<Vars>(...)` and the new variables become available to every route under that context, with type-level guards against redeclaration.
- **Per-route policy hook** — register a `routeMiddleware` factory once on the router; it runs against every declared route with full access to the resolved `RouteConfig`. Drop-in spot for scope checks, audit logging, rate limits, anything cross-cutting.
- **OpenAPI built-in** — every route is declared via `createRoute`; the resulting app has full OpenAPI metadata.

## Install

```sh
npm i hono-typed-router hono @hono/zod-openapi zod
```

Peer deps: `hono ^4.12`, `@hono/zod-openapi ^1.1`, `zod ^4`.

## Quick start

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createRouter,
  defineRootRoute,
  defineChildRoute,
  makeHonoResponse,
} from 'hono-typed-router';

const okResponse = makeHonoResponse(z.object({ ok: z.boolean() }), 'OK');

// 1. Define the root context — base path + global middlewares.
const rootRoute = defineRootRoute('/api', []);

// 2. Build a router factory. Hooks attached here apply to every router built from it.
const makeRouter = createRouter();

// 3. Declare a child context. The path is concatenated at the type level.
const thingsRoute = defineChildRoute<typeof rootRoute>()('/things');

// 4. Build the router. `route()` declares + returns a RouteConfig; `router.openapi()`
//    registers the handler.
const thingsRouter = makeRouter(thingsRoute, ({ router, route }) => {
  const list = route('get', { responses: { 200: okResponse } });
  router.openapi(list, (c) => c.json({ ok: true }));
  return router;
});

// 5. Mount children under the root and expose the final Hono app.
const app = makeRouter(rootRoute, ({ router }) => router, [thingsRouter])();
// GET /api/things -> { ok: true }
```

## Concepts

### `defineRootRoute(path, middlewares)`

Creates the root `RouteContext`. The `path` becomes the base path of any router built from this context, and the `middlewares` array runs on every request that hits routers under it.

### `defineChildRoute<typeof parent>()(path)`

Creates a child `RouteContext`. The child's path type is `${ParentPath}${ChildPath}`; its variables are inherited from the parent. Children are mounted on the parent in `makeRouter(parent, factory, [child])`.

### `.middleware<NewVars>(handler)`

Adds a middleware to the context and surfaces any new variables it sets on `c.var` to subsequent middleware and route handlers. Redeclaring an existing variable is a type error.

```ts
type SessionVar = { session: { userId: string } };

const authed = defineRootRoute('/api', []).middleware<SessionVar>(async (c, next) => {
  c.set('session', await loadSession(c));
  await next();
});

const meRoute = defineChildRoute<typeof authed>()('/me');
//  routes built from meRoute see `c.var.session` typed.
```

### `createRouter({ routeMiddleware? })`

Returns a `makeRouter`. Optional `routeMiddleware` is a factory (or array of factories) of the form `(route: RouteConfig) => MiddlewareHandler`. Each factory is invoked **once at route declaration** with the resolved `RouteConfig`; the returned middleware is attached to the route's exact method + path.

```ts
const makeRouter = createRouter({
  routeMiddleware: [
    (route) => async (c, next) => {
      console.log('hit', route.method, route.path);
      await next();
    },
  ],
});
```

Use array form to compose multiple concerns (scope check + request log + audit). Each middleware can call `next()` to continue or return a `Response` to short-circuit, exactly like a regular Hono middleware.

#### `base` — shared RouteConfig fragment

A partial `RouteConfig` deep-merged into every route declared by this router. Per-route values win on key conflicts; arrays (e.g. `security`, `tags`) are concatenated and structurally deduplicated; **two zod schemas at the same position are unioned** (`base.or(route)`) so a per-route `422` schema is combined with the base `422` schema rather than replacing it. The merged shape is reflected in the static type returned by `route()`, so handlers see the combined `responses`/`request` schema (with `ZodUnion<[base, route]>` at colliding schema slots).

```ts
const unauthorized = makeHonoResponse(z.object({ error: z.string() }), 'Unauthorized');

const makeRouter = createRouter({
  base: { responses: { 401: unauthorized } },
});

makeRouter(rootRoute, ({ router, route }) => {
  const list = route('get', { responses: { 200: okResponse } });
  // `list.responses` is typed with both `200` and `401`.
  router.openapi(list, (c) => c.json({ ok: true }));
  return router;
});
```

#### `transformRoute` — runtime-only config transformer

A hook of the form `(config: RouteConfig) => RouteConfig`. It runs immediately after the resolved `RouteConfig` is produced (and after any `base` merge), and *before* `routeMiddleware` factories see it. The static type of the returned config is unchanged — this is purely a runtime escape hatch for cross-cutting mutations (auto-tagging, injecting metadata, normalizing security entries, etc.).

```ts
const makeRouter = createRouter({
  transformRoute: (route) => ({
    ...route,
    tags: [...(route.tags ?? []), `${route.method}:${route.path}`],
  }),
});
```

### `route(method, config)`

Inside a router factory, `route()` builds and returns a `createRoute()` config with its path locked to the context's path. The returned config feeds straight into `router.openapi(config, handler)`.

## Scope-check helper

A common use of `routeMiddleware` is enforcing OAuth-style scopes declared on a route's `security`. Use the sub-entry helper:

```ts
import { createRouter } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';

const makeRouter = createRouter({
  routeMiddleware: createScopeMiddleware({
    resolve: (c) => c.var.session.scopes,
    // optional: customize the 403 body
    onForbidden: (missing) => ({ code: 'FORBIDDEN', missing }),
  }),
});
```

Behavior:

- Extracts required scopes from every entry in `route.security`, flattening across schemes and deduplicating.
- If `route.security` is absent or empty, the middleware is a no-op.
- If any required scope is missing from `resolve(c)`, returns **403** with the configured body.

## Helpers

These mirror the shape `@hono/zod-openapi` expects:

```ts
import {
  makeHonoResponse,
  makeHonoJsonBody,
  makeHonoJsonRequest,
  makeHonoNoContentResponse,
} from 'hono-typed-router';

const route = createRoute({
  method: 'post',
  path: '/things',
  request: makeHonoJsonRequest(CreateBody, 'Create a thing'),
  responses: {
    200: makeHonoResponse(Thing, 'The created thing'),
    204: makeHonoNoContentResponse('Deleted'),
  },
});
```

## Recipes

### Binding a repository to a path parameter

The common "load `:id` once, expose it on `c.var`" pattern is a thin wrapper around `.middleware`:

```ts
import type { RouteContext } from 'hono-typed-router';
import type { ParamKeys } from 'hono/types';

const bindOrganization = <P extends string, V extends object>(
  ctx: RouteContext<P, V>,
  param: ParamKeys<P>,
) =>
  ctx.middleware<{ organization: Organization }>(async (c, next) => {
    const id = c.req.param(param as string);
    const organization = await organizationsRepository.findById(id);
    if (!organization) return c.json({ error: 'NOT_FOUND' }, 404);
    c.set('organization', organization);
    await next();
  });

const orgRoute = bindOrganization(
  defineChildRoute<typeof rootRoute>()('/organizations/:organizationId'),
  'organizationId',
);
```

### Multiple `routeMiddleware` hooks

```ts
const makeRouter = createRouter({
  routeMiddleware: [
    createScopeMiddleware({ resolve: (c) => c.var.session.scopes }),
    (route) => async (c, next) => {
      const start = Date.now();
      await next();
      logger.info({ method: route.method, path: route.path, ms: Date.now() - start });
    },
  ],
});
```

## Documentation

- [`docs/usage.md`](./docs/usage.md) — copy-pastable examples: CRUD resources, nested children, serving, OpenAPI UI, opt-outs, testing.
- [`docs/api.md`](./docs/api.md) — full signature reference.
- [`docs/design.md`](./docs/design.md) — rationale and deliberate omissions.

## License

MIT
