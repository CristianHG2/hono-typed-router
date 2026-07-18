# Usage

Examples are self-contained and copy-pastable. They build on each other but are also fine to read in isolation.

## Recommended project layout

The library does not enforce a file structure, but it is designed to be used **one route per file, with directories mirroring the URL hierarchy** — a hand-rolled file-based router. This keeps the type system doing the work: each file imports its parent's context and declares its own segment, and a top-level barrel composes the tree.

### Conventions

- **One context per file.** Each file declares exactly one `RouteContext` (root, child, or grandchild) and exactly one router built from it.
- **Directories mirror the URL.** `/api/organizations/:orgId/departments` → `routes/organizations/[orgId]/departments/index.ts`.
- **Dynamic segments use `[brackets]` in folder/file names** — they map to `:colon` segments in the path string. `[orgId]` ↔ `:orgId`.
- **`index.ts` = the collection** (`/things`); **`[id].ts` = the item** (`/things/:id`).
- **Each file exports its `RouteContext` *and* its built router.** The context is imported by child files; the router is mounted by the parent.
- **The root file (`routes/index.ts`) lists all top-level children**, each child file lists its own grandchildren, and so on. There is no central registry — the tree composes itself.

### Example tree

```
routes/
  index.ts                                     #  ''   (root)
  health.ts                                    # /health
  organizations/
    index.ts                                   # /organizations
    [orgId]/
      index.ts                                 # /organizations/:orgId
      departments/
        index.ts                               # /organizations/:orgId/departments
        [departmentId].ts                      # /organizations/:orgId/departments/:departmentId
```

### What each file looks like

**`routes/index.ts`** — root context + global middleware, mounts top-level children:

```ts
import { defineRootRoute } from 'hono-typed-router';
import { makeRouter } from './_router';
import { authMiddleware } from '../middlewares/auth';
import { organizationsRouter } from './organizations';
import { healthRouter } from './health';

export const rootRoute = defineRootRoute('', [authMiddleware]);

export const rootRouter = makeRouter(rootRoute, ({ router }) => router, [
  healthRouter,
  organizationsRouter,
]);
```

**`routes/_router.ts`** — shared `createRouter` instance so policy lives in one place:

```ts
import { createRouter } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';

export const makeRouter = createRouter({
  routeMiddleware: createScopeMiddleware({ resolve: (c) => c.var.session.scopes }),
});
```

**`routes/organizations/index.ts`** — collection endpoints:

```ts
import { defineChildRoute, makeHonoResponse } from 'hono-typed-router';
import { z } from 'zod';
import { rootRoute } from '..';
import { makeRouter } from '../_router';
import { organizationRouter } from './[orgId]';

export const organizationsRoute = defineChildRoute<typeof rootRoute>()('/organizations');

export const organizationsRouter = makeRouter(
  organizationsRoute,
  ({ router, route }) => {
    router.openapi(
      route('get', { responses: { 200: makeHonoResponse(z.array(Organization), 'OK') } }),
      async (c) => c.json(await db.organizations.list()),
    );
    return router;
  },
  [organizationRouter],
);
```

**`routes/organizations/[orgId]/index.ts`** — item context that also loads the parent resource for its children:

```ts
import { defineChildRoute, makeHonoResponse } from 'hono-typed-router';
import { organizationsRoute } from '..';
import { makeRouter } from '../../_router';
import { organizationDepartmentsRouter } from './departments';
import { bindOrganization } from './_bind';

export const organizationRoute = bindOrganization(
  defineChildRoute<typeof organizationsRoute>()('/:orgId'),
  'orgId',
);

export const organizationRouter = makeRouter(
  organizationRoute,
  ({ router, route }) => {
    router.openapi(
      route('get', { responses: { 200: makeHonoResponse(Organization, 'OK') } }),
      (c) => c.json(c.var.organization),
    );
    return router;
  },
  [organizationDepartmentsRouter],
);
```

**`routes/organizations/[orgId]/departments/[departmentId].ts`** — leaf item:

```ts
import { defineChildRoute, makeHonoNoContentResponse } from 'hono-typed-router';
import { organizationDepartmentsRoute } from '.';
import { makeRouter } from '../../../_router';

export const organizationDepartmentRoute = defineChildRoute<typeof organizationDepartmentsRoute>()(
  '/:departmentId',
);

export const organizationDepartmentRouter = makeRouter(
  organizationDepartmentRoute,
  ({ router, route }) => {
    router.openapi(
      route('delete', { responses: { 204: makeHonoNoContentResponse('Deleted') } }),
      async (c) => {
        await db.departments.delete(c.req.param('departmentId'));
        return c.body(null, 204);
      },
    );
    return router;
  },
);
```

### Why this layout

- The compiler proves the URL hierarchy: a grandchild that imports the wrong parent's context produces a path-type mismatch at the `defineChildRoute<typeof parent>()` site.
- A new endpoint never requires touching a registry — you add a file, and its parent picks it up via the `children` array.
- File system navigation matches URL navigation. Searching `[orgId]/departments` finds every route under that subtree.
- `c.var` is precisely typed at every depth without manual interface declarations.

The rest of this document uses inlined examples for brevity, but in a real project each example would be its own file under the tree above.

## A complete CRUD resource

A single resource with collection + item endpoints, declared in two contexts (`routes/things/index.ts` and `routes/things/[id].ts` in the recommended layout, but inlined here for readability):

```ts
import { z } from 'zod';
import {
  createRouter,
  defineChildRoute,
  defineRootRoute,
  makeHonoJsonRequest,
  makeHonoNoContentResponse,
  makeHonoResponse,
} from 'hono-typed-router';

const Thing = z.object({ id: z.string(), name: z.string() });
const CreateThing = z.object({ name: z.string().min(1) });

const apiRoute = defineRootRoute('/api', []);
const thingsRoute = defineChildRoute<typeof apiRoute>()('/things');
const thingRoute = defineChildRoute<typeof apiRoute>()('/things/:id');

const makeRouter = createRouter();

const collection = makeRouter(thingsRoute, ({ router, route }) => {
  const list = route('get', {
    responses: { 200: makeHonoResponse(z.array(Thing), 'List of things') },
  });
  const create = route('post', {
    request: makeHonoJsonRequest(CreateThing, 'Create a thing'),
    responses: { 201: makeHonoResponse(Thing, 'Created') },
  });

  router.openapi(list, async (c) => c.json(await db.things.list()));
  router.openapi(create, async (c) => c.json(await db.things.create(c.req.valid('json')), 201));

  return router;
});

const item = makeRouter(thingRoute, ({ router, route }) => {
  const read = route('get', {
    responses: {
      200: makeHonoResponse(Thing, 'A thing'),
      404: makeHonoNoContentResponse('Not found'),
    },
  });
  const remove = route('delete', {
    responses: { 204: makeHonoNoContentResponse('Deleted') },
  });

  router.openapi(read, async (c) => {
    const thing = await db.things.find(c.req.param('id'));
    return thing ? c.json(thing) : c.body(null, 404);
  });
  router.openapi(remove, async (c) => {
    await db.things.delete(c.req.param('id'));
    return c.body(null, 204);
  });

  return router;
});

const app = makeRouter(apiRoute, ({ router }) => router, [collection, item])();
```

## Nesting children

Children can mount further children. Each level keeps its accumulated path and vars:

```ts
const rootRoute = defineRootRoute('/api', []);
const orgsRoute = defineChildRoute<typeof rootRoute>()('/organizations/:orgId');
const deptsRoute = defineChildRoute<typeof orgsRoute>()('/departments');
// deptsRoute.path is '/api/organizations/:orgId/departments'

const departments = makeRouter(deptsRoute, ({ router, route }) => {
  router.openapi(
    route('get', { responses: { 200: makeHonoResponse(z.array(Department), 'OK') } }),
    async (c) => c.json(await db.departments.listFor(c.req.param('orgId'))),
  );
  return router;
});

const organization = makeRouter(orgsRoute, ({ router }) => router, [departments]);
const root = makeRouter(rootRoute, ({ router }) => router, [organization])();
```

## Reusing context middleware across children

A common pattern: load the parent resource once and expose it to all children.

```ts
import type { ParamKeys } from 'hono/types';
import type { RouteContext } from 'hono-typed-router';

const bindOrganization = <P extends string, V extends object>(
  ctx: RouteContext<P, V>,
  param: ParamKeys<P>,
) =>
  ctx.middleware<{ organization: Organization }>(async (c, next) => {
    const id = c.req.param(param as string);
    const organization = await db.organizations.find(id);
    if (!organization) return c.json({ error: 'NOT_FOUND' }, 404);
    c.set('organization', organization);
    await next();
  });

const orgsRoute = bindOrganization(
  defineChildRoute<typeof rootRoute>()('/organizations/:orgId'),
  'orgId',
);

const departments = makeRouter(
  defineChildRoute<typeof orgsRoute>()('/departments'),
  ({ router, route }) => {
    router.openapi(
      route('get', { responses: { 200: makeHonoResponse(z.array(Department), 'OK') } }),
      async (c) => {
        const org = c.var.organization; //  typed
        return c.json(await db.departments.listFor(org.id));
      },
    );
    return router;
  },
);
```

## Serving the app (Node, Bun, Cloudflare Workers)

`makeRouter(...)()` returns a plain `OpenAPIHono` instance — you serve it the same way you serve any Hono app.

```ts
// Node
import { serve } from '@hono/node-server';
serve({ fetch: app.fetch, port: 3000 });

// Bun
Bun.serve({ fetch: app.fetch });

// Cloudflare Workers
export default { fetch: app.fetch };
```

## Exposing the OpenAPI document + Swagger UI

```ts
import { swaggerUI } from '@hono/swagger-ui';
import { apiReference } from '@scalar/hono-api-reference';

app.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'My API', version: '1.0.0' },
});

app.get('/docs', swaggerUI({ url: '/openapi.json' }));
app.get('/reference', apiReference({ spec: { url: '/openapi.json' } }));
```

## Cross-cutting policy with `routeMiddleware`

Attach policy once at the factory; it runs against every declared route with the resolved `RouteConfig`.

```ts
import { createScopeMiddleware } from 'hono-typed-router/scopes';

const makeRouter = createRouter({
  routeMiddleware: [
    // 1. Enforce scopes declared via createRoute({ security: [{ oauth2: [...] }] })
    createScopeMiddleware({
      resolve: (c) => c.var.session.scopes,
    }),

    // 2. Log every request with its route metadata
    (route) => async (c, next) => {
      const start = Date.now();
      await next();
      logger.info({
        method: route.method,
        tags: route.tags,
        status: c.res.status,
        ms: Date.now() - start,
      });
    },

    // 3. Tag responses with their operationId for client correlation
    (route) => async (c, next) => {
      await next();
      if (route.operationId) c.header('X-Operation-Id', route.operationId);
    },
  ],
});
```

The factories run in order at declaration; the resulting middlewares run in order at request time.

## Sharing a `base` RouteConfig across every route

Use `base` to deep-merge a partial `RouteConfig` into every route built by this `makeRouter`. Common cases: a shared `401`/`403`/`422` response, project-wide `security`, default `tags`. Per-route values override base; arrays concat + dedupe; zod schemas at the same slot are unioned.

```ts
const Unauthorized = z.object({ error: z.literal('UNAUTHORIZED') });
const Forbidden = z.object({ error: z.literal('FORBIDDEN') });
const BaseValidation = z.object({ code: z.literal('BASE_INVALID'), issues: z.array(z.string()) });

const makeRouter = createRouter({
  base: {
    tags: ['v1'],
    responses: {
      401: makeHonoResponse(Unauthorized, 'Unauthorized'),
      403: makeHonoResponse(Forbidden, 'Forbidden'),
      422: makeHonoResponse(BaseValidation, 'Validation error (default)'),
    },
  },
});

const things = makeRouter(thingsRoute, ({ router, route }) => {
  const RouteValidation = z.object({ code: z.literal('NAME_TOO_LONG') });

  const create = route('post', {
    tags: ['things'], // merged → ['v1', 'things']
    request: makeHonoJsonRequest(CreateThing, 'Create a thing'),
    responses: {
      201: makeHonoResponse(Thing, 'Created'),
      422: makeHonoResponse(RouteValidation, 'Validation error (route)'),
      // 401 + 403 inherited from base; 422 schema becomes
      // ZodUnion<[BaseValidation, RouteValidation]> at both type & runtime.
    },
  });

  router.openapi(create, async (c) => c.json(await db.things.create(c.req.valid('json')), 201));
  return router;
});
```

The handler now has to satisfy a `responses` object containing `201`, `401`, `403`, *and* `422` — TypeScript will tell you if you forgot a discriminant in a returned union body.

## Mutating every RouteConfig at runtime with `transformRoute`

`transformRoute` is a `(RouteConfig) => RouteConfig` hook that runs after `createRoute()` (and after the `base` merge), before the config is handed to `routeMiddleware` factories. It does **not** change the static return type of `route()`; use it for runtime-only enrichments.

```ts
const makeRouter = createRouter({
  transformRoute: (route) => ({
    ...route,
    operationId: route.operationId ?? `${route.method}_${route.path.replace(/[^a-z0-9]+/gi, '_')}`,
    tags: [...new Set([...(route.tags ?? []), `${route.method.toUpperCase()} ${route.path}`])],
  }),
});
```

Typical uses:
- Auto-derive `operationId` from method + path.
- Inject environment-specific tags (`tags: [...route.tags ?? [], process.env.STAGE]`).
- Normalize `security` to always include a default scheme.

## Opting a route out of the global policy

Two idiomatic options.

**Tag the route and skip in the factory.** The factory sees the full `RouteConfig`, so use any field you like — `tags`, `operationId`, an extension property.

```ts
const makeRouter = createRouter({
  routeMiddleware: (route) => {
    if (route.tags?.includes('public')) {
      return async (_c, next) => next();
    }
    return createScopeMiddleware({ resolve: (c) => c.var.session.scopes })(route);
  },
});

// Declare the route as public
route('get', { tags: ['public'], responses: { 200: okResponse } });
```

**Build a second router factory for public-only routes.** Useful when whole subtrees share the policy difference.

```ts
const makeAuthedRouter = createRouter({ routeMiddleware: scopeCheck });
const makePublicRouter = createRouter();

const health = makePublicRouter(defineChildRoute<typeof apiRoute>()('/health'), /* ... */);
const things = makeAuthedRouter(defineChildRoute<typeof apiRoute>()('/things'), /* ... */);

const app = makeAuthedRouter(apiRoute, ({ router }) => router, [health, things])();
```

## Custom error bodies from middleware

Returning a `Response` from a `routeMiddleware` short-circuits the chain. Use this for policy responses; throw for actual errors so `app.onError` can format them centrally.

```ts
const rateLimit = (limiter: Limiter) => () => async (c: Context, next: Next) => {
  const verdict = await limiter.check(c.req.header('x-api-key') ?? '');
  if (!verdict.allowed) {
    return c.json(
      { error: 'RATE_LIMITED', retryAfterSeconds: verdict.retryAfter },
      429,
      { 'Retry-After': String(verdict.retryAfter) },
    );
  }
  await next();
};

const makeRouter = createRouter({
  routeMiddleware: [rateLimit(globalLimiter)],
});
```

## Type-safe error handling in handlers

Where `routeMiddleware` handles cross-cutting policy, `handler(c, fn).errors([...])`
handles per-handler failures — mapping thrown domain errors to responses while
keeping the OpenAPI contract honest.

```ts
import { handler, on, rethrow } from 'hono-typed-router';

const getThing = route('get', {
  request: { params: thingIdParam },
  responses: {
    200: makeHonoResponse(Thing, 'The thing'),
    404: makeHonoResponse(ErrorBody, 'Not found'),
    409: makeHonoResponse(ErrorBody, 'Conflict'),
  },
});

router.openapi(getThing, (c) =>
  handler(c, async ({ param: { id } }) => c.json(await thingsRepo.findOrFail(id), 200))
    .errors([
      on(RecordNotFoundError, (_err, ec) => ec.json({ message: 'Thing not found' }, 404)),
      on(UniqueConstraintError, (err, ec) => {
        if (!err.columns.includes('slug')) return rethrow(); // defer to a later arm / rethrow
        return ec.json({ message: 'Slug already taken' }, 409);
      }),
    ]),
);
```

Key points:

- `fn` receives a **destructurable proxy** over validated inputs (`{ param, query, json, ... }`), each typed from the route. Targets are read lazily from `c.req.valid` and cached, so untouched targets are never read.
- `.errors([...])` runs the body under the arms and **widens the return type with each arm's response**. Since that value is what `router.openapi(...)` type-checks, an arm returning a status the route did not declare in `responses` (or a body body shape that doesn't match) is a **compile error**. Remove the `404`/`409` from `responses` above and the handler stops type-checking.
- Arms are reusable. Factor common ones into helpers:

  ```ts
  export const recordNotFoundArm = (message: string) =>
    on(RecordNotFoundError, (_err, c) => c.json({ message }, 404));
  ```

- Need the dispatch without the input proxy? Use `handleErrors(body, arms, c)` directly — same semantics, same widened return type.

## Adding custom builders with `extendRouteContext`

The "load `:id` once, expose it on `c.var`" pattern (and similar context builders)
can be promoted to a first-class, type-safe method on `defineRootRoute` /
`defineChildRoute`.

```ts
import { extendRouteContext } from 'hono-typed-router';
import type {
  ReaugmentContext,
  RouteContextBase,
  RouteContextKind,
} from 'hono-typed-router';
import type { MiddlewareHandler } from 'hono';
import type { ParamKeys } from 'hono/types';

// 1. Describe the extended context as a self-referential interface.
interface Ctx<TPath extends string, TVars extends object>
  extends RouteContextBase<CtxKind, TPath, TVars> {
  bindRepository: <TKey extends string, TRepo extends { findOrFail(id: string): unknown }>(
    key: TKey extends keyof TVars ? `Cannot redeclare existing var: "${TKey}"` : TKey,
    param: ParamKeys<TPath>,
    repository: () => TRepo,
  ) => ReaugmentContext<CtxKind, TPath, TVars & { [K in TKey]: Awaited<ReturnType<TRepo['findOrFail']>> }>;
}
// 2. One-line kind pairing the interface to its type parameters.
interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

// 3. Provide the runtime builders; ctx.middleware() already re-augments.
//    The handler sets a var the loose builder context can't name, so type it as a
//    plain MiddlewareHandler and cast when handing it to ctx.middleware().
export const { defineRootRoute, defineChildRoute } = extendRouteContext<CtxKind>({
  bindRepository: (ctx) => (key, param, repository) => {
    const mw: MiddlewareHandler = async (c, next) => {
      c.set(key, await repository().findOrFail(c.req.param(param)));
      await next();
    };
    return ctx.middleware(mw as never);
  },
});

// 4. Use it — fully typed, chainable, and still exposes `.middleware()`.
const orgRoute = defineChildRoute<typeof rootRoute>()('/organizations/:organizationId')
  .bindRepository('organization', 'organizationId', () => organizationsRepository);
//    orgRoute.vars.organization is typed; bindRepository/middleware remain available.
```

The `key` argument rejects redeclaring an existing var, and `param` is constrained
to the route's path parameters — both at the type level. Because the extended
context is an **interface**, chaining is unbounded without tripping TypeScript's
recursion limit.

## Testing a router

`OpenAPIHono` exposes `.request(path, init?)` — a fetch-style call against the in-process app. No server needed.

```ts
import { expect, it } from 'vitest';

it('rejects requests missing scopes', async () => {
  const app = makeApp({ session: { scopes: [] } });
  const res = await app.request('/api/things', { method: 'POST' });

  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: 'E_FORBIDDEN' });
});
```

For end-to-end tests of declared schemas, prefer `c.req.valid('json')` inside handlers and assert against the actual response body — the schema validates the request automatically when registered through `router.openapi(...)`.

## Composing with regular Hono middleware

`routeMiddleware` is for per-route policy. For app-wide middleware (CORS, gzip, logger) just install it on the final app:

```ts
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = makeRouter(apiRoute, ({ router }) => router, [/* … */])();

app.use('*', logger());
app.use('/api/*', cors({ origin: 'https://example.com' }));
```

Order matters: `app.use` must run before requests arrive, but it can run after `makeRouter(...)()` since the returned app is the same instance subsequent calls modify.
