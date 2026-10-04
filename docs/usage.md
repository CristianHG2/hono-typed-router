# Usage

Examples are self-contained and copy-pastable. They build on each other but are also fine to read in isolation.

## Recommended project layout

The library does not enforce a file structure, but it is designed to be used **one route per file, with directories mirroring the URL hierarchy** — a hand-rolled file-based router. This keeps the type system doing the work: each file imports its parent's context and declares its own segment, and a top-level barrel composes the tree.

This layout has circular imports: a parent file imports its children's routers to mount them, and each child file imports its parent's context. So the files below use the **curried form**, `defineChildRoute<typeof parent>()(segment)`, with an `import type` of the parent. A type-only import has no runtime cycle. The value form, `defineChildRoute(parent, segment)`, needs the parent value when the child module loads, and in a cycle that value is not initialized yet. Use the value form when the child is declared in the same file as its parent, or in a module that its parent does not import (the rest of this document does that).

### Conventions

- **One context per file.** Each file declares exactly one `RouteContext` (root, child, or grandchild) and exactly one router built from it.
- **Directories mirror the URL.** `/api/organizations/:orgId/departments` → `routes/organizations/[orgId]/departments/index.ts`.
- **Dynamic segments use `[brackets]` in folder/file names** — they map to `:colon` segments in the path string. `[orgId]` ↔ `:orgId`.
- **`index.ts` = the collection** (`/things`); **`[id].ts` = the item** (`/things/:id`).
- **Each file exports its `RouteContext` _and_ its built router.** The context is imported by child files; the router is mounted by the parent.
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
import { defineChildRoute, jsonResponse } from 'hono-typed-router';
import { z } from 'zod';
import type { rootRoute } from '..';
import { makeRouter } from '../_router';
import { organizationRouter } from './[orgId]';

export const organizationsRoute = defineChildRoute<typeof rootRoute>()('/organizations');

export const organizationsRouter = makeRouter(
  organizationsRoute,
  ({ router, defineRoute }) =>
    router.openapi(
      defineRoute('get', { responses: { 200: jsonResponse(z.array(Organization), 'OK') } }),
      async (c) => c.json(await db.organizations.list()),
    ),
  [organizationRouter],
);
```

**`routes/organizations/[orgId]/index.ts`** — item context that also loads the parent resource for its children:

```ts
import { defineChildRoute, jsonResponse } from 'hono-typed-router';
import type { organizationsRoute } from '..';
import { makeRouter } from '../../_router';
import { organizationDepartmentsRouter } from './departments';
import { bindOrganization } from './_bind';

export const organizationRoute = bindOrganization(
  defineChildRoute<typeof organizationsRoute>()('/:orgId'),
  'orgId',
);

export const organizationRouter = makeRouter(
  organizationRoute,
  ({ router, defineRoute }) =>
    router.openapi(
      defineRoute('get', { responses: { 200: jsonResponse(Organization, 'OK') } }),
      (c) => c.json(c.var.organization),
    ),
  [organizationDepartmentsRouter],
);
```

**`routes/organizations/[orgId]/departments/[departmentId].ts`** — leaf item:

```ts
import { defineChildRoute, emptyResponse } from 'hono-typed-router';
import type { organizationDepartmentsRoute } from '.';
import { makeRouter } from '../../../_router';

export const organizationDepartmentRoute =
  defineChildRoute<typeof organizationDepartmentsRoute>()('/:departmentId');

export const organizationDepartmentRouter = makeRouter(
  organizationDepartmentRoute,
  ({ router, defineRoute }) =>
    router.openapi(
      defineRoute('delete', { responses: { 204: emptyResponse('Deleted') } }),
      async (c) => {
        await db.departments.delete(c.req.param('departmentId'));
        return c.body(null, 204);
      },
    ),
);
```

### Why this layout

- The compiler proves the URL hierarchy: a grandchild that imports the wrong parent's context gets the wrong path type at the `defineChildRoute<typeof parent>()` site, which shows up where its routes use path params.
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
  jsonRequest,
  emptyResponse,
  jsonResponse,
} from 'hono-typed-router';

const Thing = z.object({ id: z.string(), name: z.string() });
const CreateThing = z.object({ name: z.string().min(1) });

const apiRoute = defineRootRoute('/api', []);
const thingsRoute = defineChildRoute(apiRoute, '/things');
const thingRoute = defineChildRoute(apiRoute, '/things/:id');

const makeRouter = createRouter();

const collection = makeRouter(thingsRoute, ({ router, defineRoute }) => {
  const list = defineRoute('get', {
    responses: { 200: jsonResponse(z.array(Thing), 'List of things') },
  });
  const create = defineRoute('post', {
    request: jsonRequest(CreateThing, 'Create a thing'),
    responses: { 201: jsonResponse(Thing, 'Created') },
  });

  return router
    .openapi(list, async (c) => c.json(await db.things.list()))
    .openapi(create, async (c) => c.json(await db.things.create(c.req.valid('json')), 201));
});

const item = makeRouter(thingRoute, ({ router, defineRoute }) => {
  const read = defineRoute('get', {
    responses: {
      200: jsonResponse(Thing, 'A thing'),
      404: emptyResponse('Not found'),
    },
  });
  const remove = defineRoute('delete', {
    responses: { 204: emptyResponse('Deleted') },
  });

  return router
    .openapi(read, async (c) => {
      const thing = await db.things.find(c.req.param('id'));
      return thing ? c.json(thing) : c.body(null, 404);
    })
    .openapi(remove, async (c) => {
      await db.things.delete(c.req.param('id'));
      return c.body(null, 204);
    });
});

const app = makeRouter(apiRoute, ({ router }) => router, [collection, item])();
```

Each factory returns its chain of `.openapi()` calls instead of calling `router.openapi(...)`
and then returning `router`. Each call returns the router with that route added to its
type; Hono's RPC client (`hc`, `testClient`) reads the routes from that type. The runtime is
the same either way.

## Nesting children

Children can mount further children. Each level keeps its accumulated path and vars:

```ts
const rootRoute = defineRootRoute('/api', []);
const orgsRoute = defineChildRoute(rootRoute, '/organizations/:orgId');
const deptsRoute = defineChildRoute(orgsRoute, '/departments');
// deptsRoute.path is '/api/organizations/:orgId/departments' (type and runtime value)

const departments = makeRouter(deptsRoute, ({ router, defineRoute }) =>
  router.openapi(
    defineRoute('get', { responses: { 200: jsonResponse(z.array(Department), 'OK') } }),
    async (c) => c.json(await db.departments.listFor(c.req.param('orgId'))),
  ),
);

const organization = makeRouter(orgsRoute, ({ router }) => router, [departments]);
const root = makeRouter(rootRoute, ({ router }) => router, [organization])();
```

## Reusing context middleware across children

A common pattern: load the parent resource once and expose it to all children. The `bindOrganization` below is the `./_bind` module that `routes/organizations/[orgId]/index.ts` imports in the layout above.

```ts
import type { ParamKeys } from 'hono/types';
import type { RouteContext } from 'hono-typed-router';

// Typed over concrete vars; for a reusable, generic builder use `extendRouteContext`.
export const bindOrganization = <P extends string>(ctx: RouteContext<P, {}>, param: ParamKeys<P>) =>
  ctx.middleware<{ organization: Organization }>(async (c, next) => {
    const id = c.req.param(param);
    const organization = id ? await db.organizations.find(id) : null;
    if (!organization) return c.json({ error: 'NOT_FOUND' }, 404);
    c.set('organization', organization);
    await next();
  });

const orgContext = defineChildRoute(rootRoute, '/organizations/:orgId');
const orgsRoute = bindOrganization(orgContext, 'orgId');

const departments = makeRouter(
  defineChildRoute(orgsRoute, '/departments'),
  ({ router, defineRoute }) =>
    router.openapi(
      defineRoute('get', { responses: { 200: jsonResponse(z.array(Department), 'OK') } }),
      async (c) => {
        const org = c.var.organization; //  typed
        return c.json(await db.departments.listFor(org.id));
      },
    ),
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

`app` is built from the root context, so its base path (for example `/api`) and the root's middlewares apply to every route registered on it: `app.doc('/openapi.json', ...)` would be served at `/api/openapi.json`, behind the root's auth middleware. Mount `app` on an outer `OpenAPIHono` and register the document and the UIs there. The outer app gets the routes and the OpenAPI definitions of `app`. Serve `server` instead of `app`.

```ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { apiReference } from '@scalar/hono-api-reference';

export const server = new OpenAPIHono().route('/', app);

server.doc('/openapi.json', {
  openapi: '3.1.0',
  info: { title: 'My API', version: '1.0.0' },
});

server.get('/docs', swaggerUI({ url: '/openapi.json' }));
server.get('/reference', apiReference({ spec: { url: '/openapi.json' } }));
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

## Sharing `routeDefaults` across every route

Use `routeDefaults` to deep-merge a partial `RouteConfig` into every route built by this `makeRouter`. Common cases: a shared `401`/`403`/`422` response, project-wide `security`, default `tags`. Per-route values override the defaults; arrays concat + dedupe (except a route `security: []`, which opts out of the default `security`); zod schemas at the same slot are unioned. (`base` is the deprecated name of this option.)

```ts
const Unauthorized = z.object({ error: z.literal('UNAUTHORIZED') });
const Forbidden = z.object({ error: z.literal('FORBIDDEN') });
const BaseValidation = z.object({ code: z.literal('BASE_INVALID'), issues: z.array(z.string()) });

const makeRouter = createRouter({
  routeDefaults: {
    tags: ['v1'],
    responses: {
      401: jsonResponse(Unauthorized, 'Unauthorized'),
      403: jsonResponse(Forbidden, 'Forbidden'),
      422: jsonResponse(BaseValidation, 'Validation error (default)'),
    },
  },
});

const things = makeRouter(thingsRoute, ({ router, defineRoute }) => {
  const RouteValidation = z.object({ code: z.literal('NAME_TOO_LONG') });

  const create = defineRoute('post', {
    tags: ['things'], // merged → ['v1', 'things']
    request: jsonRequest(CreateThing, 'Create a thing'),
    responses: {
      201: jsonResponse(Thing, 'Created'),
      422: jsonResponse(RouteValidation, 'Validation error (route)'),
      // 401 + 403 inherited from routeDefaults; 422 schema becomes
      // ZodUnion<[BaseValidation, RouteValidation]> at both type & runtime.
    },
  });

  return router.openapi(create, async (c) =>
    c.json(await db.things.create(c.req.valid('json')), 201),
  );
});
```

The handler now has to satisfy a `responses` object containing `201`, `401`, `403`, _and_ `422` — TypeScript will tell you if you forgot a discriminant in a returned union body.

## Mutating every RouteConfig at runtime with `transformRoute`

`transformRoute` is a `(config: RouteConfig, meta: RouteHookMeta) => RouteConfig` hook that runs after `createRoute()` (and after the `routeDefaults` merge), before the config is handed to `routeMiddleware` factories. It does **not** change the static return type of `defineRoute()`; use it for runtime-only enrichments.

```ts
const makeRouter = createRouter({
  transformRoute: (config) => ({
    ...config,
    summary: config.summary ?? config.operationId,
    tags: [...new Set([...(config.tags ?? []), config.method === 'get' ? 'read' : 'write'])],
  }),
});
```

### Deriving `operationId` from the path

`config.path` is relative to the router (usually `'/'`), so it is not unique. Use `meta.path`, the router's full mount path joined with the route's path, and replace the characters that are not valid in an identifier:

```ts
const makeRouter = createRouter({
  transformRoute: (config, meta) => ({
    ...config,
    // GET /api/things/:id -> 'get_api_things_id'
    operationId:
      config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
  }),
});
```

`meta.path` uses Hono's `:param` syntax, not OpenAPI's `{param}`. It is the full URL path when the router is mounted under its parent, for value-form (`defineChildRoute(parent, segment)`) and curried (`defineChildRoute<typeof parent>()(segment)`) children alike. A curried child's thunk called on its own, with no parent, only knows its own segment, so `meta.path` then starts at that segment.

Typical uses of `transformRoute`:

- Fill in a default `summary` from the route's `operationId`.
- Inject environment-specific tags (`tags: [...route.tags ?? [], process.env.STAGE]`).
- Normalize `security` to always include a default scheme.

## Opting a route out of the global policy

**Set `security: []` on the route.** When `routeDefaults` sets a `security` requirement, a route with `security: []` opts out of it. The merged `security` is `[]` (also in the static type of `defineRoute()`), so `createScopeMiddleware` does not check scopes and the generated OpenAPI operation is public. This rule applies to `security` only: `tags: []` and other empty arrays are still merged with `routeDefaults`.

```ts
const makeRouter = createRouter({
  routeDefaults: { security: [{ bearer: ['things:read'] }] },
  routeMiddleware: createScopeMiddleware({ resolve: (c) => c.var.session.scopes }),
});

makeRouter(apiRoute, ({ router, defineRoute }) => {
  // Public: no scope check, `security: []` in the OpenAPI document.
  const health = defineRoute('get', { security: [], responses: { 200: okResponse } });
  // Inherits `routeDefaults.security`: requires `things:read`.
  const list = defineRoute('post', { responses: { 200: okResponse } });
  // ...
  return router;
});
```

**Build a second router factory for public-only routes.** Useful when whole subtrees share the policy difference, or when the policy is not driven by `security`.

```ts
const makeAuthedRouter = createRouter({ routeMiddleware: scopeCheck });
const makePublicRouter = createRouter();

const health = makePublicRouter(defineChildRoute(apiRoute, '/health') /* ... */);
const things = makeAuthedRouter(defineChildRoute(apiRoute, '/things') /* ... */);

const app = makeAuthedRouter(apiRoute, ({ router }) => router, [health, things])();
```

## Custom error bodies from middleware

Returning a `Response` from a `routeMiddleware` short-circuits the chain. Use this for policy responses; throw for actual errors so `app.onError` can format them centrally.

```ts
const rateLimit = (limiter: Limiter) => () => async (c: Context, next: Next) => {
  const verdict = await limiter.check(c.req.header('x-api-key') ?? '');
  if (!verdict.allowed) {
    return c.json({ error: 'RATE_LIMITED', retryAfterSeconds: verdict.retryAfter }, 429, {
      'Retry-After': String(verdict.retryAfter),
    });
  }
  await next();
};

const makeRouter = createRouter({
  routeMiddleware: [rateLimit(globalLimiter)],
});
```

## Type-safe error handling in handlers

Where `routeMiddleware` handles cross-cutting policy, `handle(c, fn, arms)`
handles per-handler failures — mapping thrown domain errors to responses while
keeping the OpenAPI contract honest.

```ts
import { handle, matchErrors, onError, rethrow } from 'hono-typed-router';

class ThingNotFound extends Error {
  readonly _tag = 'ThingNotFound' as const;
}

class SlugTaken extends Error {
  readonly _tag = 'SlugTaken' as const;
  constructor(readonly slug: string) {
    super();
  }
}

const getThing = defineRoute('get', {
  request: { params: thingIdParam },
  responses: {
    200: jsonResponse(Thing, 'The thing'),
    404: jsonResponse(ErrorBody, 'Not found'),
    409: jsonResponse(ErrorBody, 'Conflict'),
  },
});

router.openapi(getThing, (c) =>
  handle(
    c,
    async ({ param: { id } }) => c.json(await thingsRepo.findOrFail(id), 200),
    matchErrors([ThingNotFound, SlugTaken], {
      ThingNotFound: (_e, ec) => ec.json({ message: 'Thing not found' }, 404),
      SlugTaken: (e, ec) => ec.json({ message: `Slug already taken: ${e.slug}` }, 409),
    }),
  ),
);
```

Key points:

- `fn` receives a **destructurable proxy** over validated inputs (`{ param, query, json, ... }`), each typed from the route. Targets are read lazily from `c.req.valid` and cached, so untouched targets are never read.
- `matchErrors(classes, handlers)` takes the error classes the route maps (TypeScript cannot infer what the body throws) and a handler per class, keyed by the class's literal `_tag`, or else its literal `name` (`override readonly name = 'X' as const`). The map is **exhaustive**: a missing key, an extra key, a class without a literal tag, or two classes with the same tag is a compile error. Each handler receives its own class's instance.
- An error that is an instance of any listed class (by `instanceof`) goes to the handler keyed by its runtime `_tag`, else its `name`. List order does not matter. Do not reuse a tag across unrelated classes: a subclass of a `name`-tagged class that declares another listed class's `_tag` goes to that class's handler, typed with the wrong class. A handler that returns `rethrow()` passes the error to the next arm, or rethrows it if there is none.
- `handle` runs the body under the arms and **widens the return type with each handler's response**. Since that value is what `router.openapi(...)` type-checks, a handler returning a status the route did not declare in `responses` (or a body shape that doesn't match) is a **compile error**. Remove the `404`/`409` from `responses` above and the handler stops type-checking. Without arms, the return type is exactly the body's.
- `matchErrors` returns a list of plain error arms. The primitive is `onError(ErrorClass, handler)`: one arm, for one class. Use it for a class without a literal tag (such as a library's error), to decide per error whether to handle it, or for arms you reuse across routes, and spread `matchErrors(...)` next to it:

  ```ts
  export const recordNotFoundArm = (message: string) =>
    onError(RecordNotFoundError, (_err, c) => c.json({ message }, 404));

  router.openapi(updateThing, (c) =>
    handle(c, async ({ param: { id }, json }) => c.json(await thingsRepo.update(id, json), 200), [
      ...matchErrors([SlugTaken], {
        SlugTaken: (e, ec) => ec.json({ message: `Slug already taken: ${e.slug}` }, 409),
      }),
      onError(UniqueConstraintError, (err, ec) => {
        if (!err.columns.includes('slug')) return rethrow(); // defer to a later arm / rethrow
        return ec.json({ message: 'Slug already taken' }, 409);
      }),
      recordNotFoundArm('Thing not found'),
    ]),
  );
  ```

- Need the dispatch without the input proxy? Use `handleErrors(body, arms, c)` directly — same semantics, same widened return type.

## Adding custom builders with `extendRouteContext`

The "load `:id` once, expose it on `c.var`" pattern (and similar context builders)
can be promoted to a first-class, type-safe method on `defineRootRoute` /
`defineChildRoute`.

```ts
import { extendRouteContext } from 'hono-typed-router';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from 'hono-typed-router';
import type { MiddlewareHandler } from 'hono';
import type { ParamKeys } from 'hono/types';

// 1. Describe the extended context as a self-referential interface.
interface Ctx<TPath extends string, TVars extends object> extends RouteContextBase<
  CtxKind,
  TPath,
  TVars
> {
  bindRepository: <TKey extends string, TRepo extends { findOrFail(id: string): unknown }>(
    key: TKey extends keyof TVars ? `Cannot redeclare existing var: "${TKey}"` : TKey,
    param: ParamKeys<TPath>,
    repository: () => TRepo,
  ) => ReaugmentContext<
    CtxKind,
    TPath,
    TVars & { [K in TKey]: Awaited<ReturnType<TRepo['findOrFail']>> }
  >;
}
// 2. One-line kind pairing the interface to its type parameters.
interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

// 3. Provide the runtime builders; ctx.middleware() already re-augments.
export const { defineRootRoute, defineChildRoute } = extendRouteContext<CtxKind>({
  bindRepository: (ctx) => (key, param, repository) => {
    const mw: MiddlewareHandler = async (c, next) => {
      c.set(key, await repository().findOrFail(c.req.param(param)));
      await next();
    };
    return ctx.middleware(mw);
  },
});

// 4. Use it — fully typed, chainable, and still exposes `.middleware()`.
const orgRoute = defineChildRoute(rootRoute, '/organizations/:organizationId').bindRepository(
  'organization',
  'organizationId',
  () => organizationsRepository,
);
//    orgRoute.vars.organization is typed; bindRepository/middleware remain available.
```

The `key` argument rejects redeclaring an existing var, and `param` is constrained
to the route's path parameters — both at the type level. Because the extended
context is an **interface**, chaining is unbounded without tripping TypeScript's
recursion limit.

## Testing a router

Use `testClient` from `hono/testing`. It calls the app in-process, with the same typed
client as `hc`: paths, params, request bodies and response bodies are typed from the
routes. No server needed.

```ts
import { testClient } from 'hono/testing';
import { expect, it } from 'vitest';

const app = makeRouter(apiRoute, ({ router }) => router, [collection, item])();
const client = testClient(app);

it('creates a thing', async () => {
  const res = await client.api.things.$post({ json: { name: 'Widget' } });

  expect(res.status).toBe(201);
  if (res.status === 201) {
    const thing = await res.json(); // { id: string; name: string }
    expect(thing.name).toBe('Widget');
  }
});

it('rejects an invalid body', async () => {
  // @ts-expect-error: `name` is required
  const res = await client.api.things.$post({ json: {} });

  expect(res.status).toBe(400);
});

it('reads a thing by id', async () => {
  const res = await client.api.things[':id'].$get({ param: { id: '42' } });

  expect([200, 404]).toContain(res.status);
});
```

Things to know:

- **Build the client from the root thunk.** The children's routes are part of the root app's
  type, at their full paths. A child thunk on its own (`testClient(item())`) has full-path
  types but serves its routes at its own segment, without the parent's middlewares, so its
  requests return 404.
- **Return the `.openapi()` chain from each factory** (see [A complete CRUD resource](#a-complete-crud-resource)).
  A factory that calls `router.openapi(...)` and returns `router` works at runtime, but its
  routes are not in the client's type.
- **Pass `children` inline** (or `as const`). A children array stored in a variable typed
  `(() => OpenAPIHono)[]` keeps the routes at runtime but drops them from the type. An
  unannotated variable that mixes different thunks (`const kids = [collection, item]`) can
  also collapse to one element type and lose some children's routes from the type.
- **Response types come from `responses`.** `res.json()` is typed from the route's declared
  responses (including `routeDefaults.responses`), not from the handler. `handle(c, fn, arms)`
  is checked against the same `responses`, so an arm cannot return an undeclared status.
- **Middleware responses are typed only if declared.** A `routeMiddleware` 403 (for example
  from `createScopeMiddleware`) reaches the client at runtime; declare `403` in the route or
  in `routeDefaults.responses` to type its body. Pass headers with the second argument:
  `client.api.things.$post({ json }, { headers: { authorization: 'Bearer …' } })`.

`OpenAPIHono` also exposes `.request(path, init?)`, a fetch-style call against the
in-process app. It is the untyped fallback, for example to send malformed JSON, which the
typed client cannot send:

```ts
const res = await app.request('/api/things', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{',
});

expect(res.status).toBe(400);
```

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
