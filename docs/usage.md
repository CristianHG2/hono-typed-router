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
