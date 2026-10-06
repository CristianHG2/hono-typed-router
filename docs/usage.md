# Usage

This guide shows the library in examples. The words context, route, middleware, route middleware factory, router maker, router, and app have the meanings that the [README glossary](../README.md#concepts) gives. The [API reference](./api.md) gives the full rules of each function.

Most examples are fragments of one API. They use names that an earlier example declares, such as `makeRouter`, `apiContext`, `okResponse`, and `SessionVars`. They also use stubs for your own code, such as `db` and `logger`. The [complete example](#complete-example) and the [project layout](#project-layout) declare all their names.

## Complete example

This example is a small API for the things of an organization. It has four routes:

- `GET /api/organizations/:organizationId` returns the organization.
- `GET /api/organizations/:organizationId/things` returns the things of the organization.
- `POST /api/organizations/:organizationId/things` makes a thing. This route requires the `things:write` scope.
- `GET /api/organizations/:organizationId/things/:id` returns one thing.

This section declares the API in one file. The [project layout](#project-layout) declares the same API with one file for each context. The `./services` module is your own code. Its `ThingNotFound` class declares `readonly _tag = 'ThingNotFound' as const`.

```ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import {
  createRouter,
  defineChildContext,
  defineRootContext,
  handle,
  jsonRequest,
  jsonResponse,
  matchErrors,
  mountRouter,
} from 'hono-typed-router';
import type { RouteMiddlewareFactory } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';
import {
  allowRequest,
  createThing,
  findOrganization,
  findThing,
  listThings,
  ThingNotFound,
  verifySession,
} from './services';
import type { Session } from './services';

interface RequestVars {
  requestId: string;
  log: (message: string) => void;
}

interface SessionVars {
  session: Session;
}

const ErrorBody = z.object({ error: z.string() });
const Organization = z.object({ id: z.string(), name: z.string() });
const Thing = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
const CreateThing = z.object({ name: z.string().min(1) });

const requireSession = createMiddleware<{ Variables: SessionVars }>(
  async function requireSession(c, next) {
    const session = await verifySession(c.req.header('authorization'));
    if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('session', session);
    await next();
  },
);

const apiContext = defineRootContext('/api')
  .middleware<RequestVars>(async function trackRequest(c, next) {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('log', (message) => console.info(JSON.stringify({ requestId, message })));
    c.header('X-Request-Id', requestId);
    await next();
    c.var.log(`${c.req.method} ${c.req.path} -> ${c.res.status}`);
  })
  .middleware(requireSession);

const organizationContext = defineChildContext(apiContext, '/organizations/:organizationId').bind(
  'organization',
  'organizationId',
  (id, c) => findOrganization(id, c.var.session.userId),
);
const thingsContext = defineChildContext(organizationContext, '/things');
const thingByIdContext = defineChildContext(thingsContext, '/:id');

const scopeMiddleware = createScopeMiddleware<SessionVars>({
  resolve: (c) => c.var.session.scopes,
});

const rateLimitMiddleware: RouteMiddlewareFactory = (route, meta) =>
  createMiddleware<{ Variables: SessionVars }>(async function rateLimit(c, next) {
    const key = `${c.var.session.userId}:${route.operationId ?? meta.path}`;
    const limitPerMinute = route.method === 'get' ? 120 : 20;
    if (!(await allowRequest(key, limitPerMinute))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    await next();
  });

const makeRouter = createRouter({
  routeDefaults: {
    responses: {
      401: jsonResponse(ErrorBody, 'Unauthorized'),
      403: jsonResponse(ErrorBody, 'Forbidden'),
      404: jsonResponse(ErrorBody, 'Not found'),
      429: jsonResponse(ErrorBody, 'Too many requests'),
    },
  },
  transformRoute: (config, meta) => ({
    ...config,
    operationId:
      config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
  }),
  routeMiddleware: [scopeMiddleware, rateLimitMiddleware],
});

const thingNotFoundArms = matchErrors([ThingNotFound], {
  ThingNotFound: (_error, c) => c.json({ error: 'NOT_FOUND' }, 404),
});

const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
  const getThingRoute = defineRoute('get', {
    responses: { 200: jsonResponse(Thing, 'The thing') },
  });

  return app.openapi(getThingRoute, (c) =>
    handle(
      c,
      async ({ param }) => c.json(await findThing(c.var.organization.id, param.id), 200),
      thingNotFoundArms,
    ),
  );
});

const thingsRouter = makeRouter(
  thingsContext,
  ({ app, defineRoute }) => {
    const listThingsRoute = defineRoute('get', {
      responses: { 200: jsonResponse(z.array(Thing), 'The things of the organization') },
    });
    const createThingRoute = defineRoute('post', {
      request: jsonRequest(CreateThing, 'The new thing'),
      responses: { 201: jsonResponse(Thing, 'The created thing') },
      security: [{ bearer: ['things:write'] }],
    });

    return app
      .openapi(listThingsRoute, async (c) => c.json(await listThings(c.var.organization.id), 200))
      .openapi(createThingRoute, async (c) => {
        const { organization, session } = c.var;
        const thing = await createThing(organization.id, session.userId, c.req.valid('json'));
        c.var.log(`created thing ${thing.id}`);
        return c.json(thing, 201);
      });
  },
  [thingByIdRouter],
);

const organizationRouter = makeRouter(
  organizationContext,
  ({ app, defineRoute }) => {
    const getOrganizationRoute = defineRoute('get', {
      responses: { 200: jsonResponse(Organization, 'The organization') },
    });

    return app.openapi(getOrganizationRoute, (c) => c.json(c.var.organization, 200));
  },
  [thingsRouter],
);

const app = mountRouter(apiContext, [organizationRouter]);

export const server = new OpenAPIHono().route('/', app);

server.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));
server.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Things API', version: '1.0.0' } });
server.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
  type: 'http',
  scheme: 'bearer',
});
```

For each request, the middlewares run in this order: `trackRequest`, `requireSession`, `bind:organization`, the scope middleware, and `rateLimit`. Then the validators, the handler, and the error arms run. Only the `POST` route has `security`, so only this route has a scope middleware.

These facts are not visible in the code:

- `trackRequest` runs first. Thus each response has an `X-Request-Id` header and a log line, also a 401 response.
- `findOrganization` returns `null` when the user is not a member. Then `.bind()` calls `c.notFound()`, and `server.notFound` sends the 404 response.
- `param` has the type `{ organizationId: string; id: string }`. `defineRoute` takes the params from the context path.
- `routeDefaults` declares each status that a middleware or an error arm returns. Thus the handlers and the client types include these statuses. Without the `404` response, the handler that uses `thingNotFoundArms` is a compile error.
- `transformRoute` keeps an `operationId` that a route sets. Otherwise it derives one from `meta.path`.
- The `bearer` name in `security` refers to the scheme that `server` registers.

Mount each child router under the router of its parent context. `thingByIdContext` is a value-form child of `thingsContext`. If you mount its router under a different router, the router throws a `TypeError`. A curried child under the wrong router does not cause an error. The child then serves at the wrong URL.

`requireSession` runs on every path under `/api`. For this reason, the outer `server` serves the OpenAPI document. This outer app gets the routes and the OpenAPI data of `app`.

### The results

The app gives these results:

| Request                                                                | Result                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET .../things` with a valid token                                    | 200 with the things of the organization                                                                               |
| `GET .../things` without a token                                       | 401 from `requireSession`, with an `X-Request-Id` header                                                              |
| `GET .../things` for an organization of which the user is not a member | 404 with `{ error: 'NOT_FOUND' }` from `.bind()` and `server.notFound`                                                |
| `POST .../things` without `things:write`                               | 403 from `scopeMiddleware`                                                                                            |
| `POST .../things` with an empty `name`                                 | 400 from the body validation                                                                                          |
| `GET .../things/:id` for an unknown `id`                               | 404 with `{ error: 'NOT_FOUND' }` from `thingNotFoundArms`                                                            |
| More requests than the limit of `allowRequest`                         | 429 from `rateLimitMiddleware`                                                                                        |
| `GET /openapi.json`                                                    | an `operationId` and the path parameters for each route, for example `get_api_organizations_organizationId_things_id` |

In this table, `...` is `/api/organizations/:organizationId`.

## Project layout

Put each context in its own file. Make the directories follow the URL. The library does not enforce this layout. With it, each file imports the type of its parent context and declares its own path segment.

These are the conventions:

- One file declares one context and one router from that context.
- The directories follow the URL. For example, `/api/organizations/:organizationId/things` is in `src/api/organizations/[organizationId]/things/index.ts`.
- A path param is a directory name or a file name in brackets. `[organizationId]` is `:organizationId`.
- `index.ts` is the collection (`/things`). `[id].ts` is the item (`/things/:id`).
- Each file exports its context and its router. The child files import the context. The parent file mounts the router.
- Each file mounts the routers of its own children. There is no central registry.
- `schemas.ts` has the zod schemas. `middleware.ts` has the vars and the context middlewares. `router.ts` has the router maker.

This layout has circular imports. A parent file imports the routers of its children. Each child file imports the context of its parent. For this reason, the files use the curried form `defineChildContext<typeof parent>()(segment)` with an `import type` of the parent. A type-only import has no runtime cycle. The API reference section [`defineChildContext`](./api.md#definechildcontextparent-path--definechildcontexttypeof-parentpath) compares the two forms.

### The tree

This tree is the API of the [complete example](#complete-example):

```
src/
  services.ts
  api/
    schemas.ts
    middleware.ts
    router.ts
    index.ts
    index.test.ts
    organizations/
      [organizationId]/
        index.ts
        things/
          index.ts
          [id].ts
```

`src/services.ts` is your own code. It exports `verifySession`, `allowRequest`, `findOrganization`, `listThings`, `createThing`, `findThing`, and the `ThingNotFound` error class. `findThing` throws `ThingNotFound` when the thing does not exist.

### The files

#### `src/api/schemas.ts`

This file has the zod schemas. The routers of more than one file use them:

```ts
import { z } from 'zod';

export const ErrorBody = z.object({ error: z.string() });
export const Organization = z.object({ id: z.string(), name: z.string() });
export const Thing = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
export const CreateThing = z.object({ name: z.string().min(1) });
```

#### `src/api/middleware.ts`

This file has the context middlewares. `trackRequest` sets `requestId` and `log`. `requireSession` sets `session`, or returns 401:

```ts
import { createMiddleware } from 'hono/factory';
import { verifySession } from '../services';
import type { Session } from '../services';

export interface RequestVars {
  requestId: string;
  log: (message: string) => void;
}

export interface SessionVars {
  session: Session;
}

export const trackRequest = createMiddleware<{ Variables: RequestVars }>(
  async function trackRequest(c, next) {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('log', (message) => console.info(JSON.stringify({ requestId, message })));
    c.header('X-Request-Id', requestId);
    await next();
    c.var.log(`${c.req.method} ${c.req.path} -> ${c.res.status}`);
  },
);

export const requireSession = createMiddleware<{ Variables: SessionVars }>(
  async function requireSession(c, next) {
    const session = await verifySession(c.req.header('authorization'));
    if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('session', session);
    await next();
  },
);
```

#### `src/api/router.ts`

This file has the router maker. Each router of the API uses it:

```ts
import { createMiddleware } from 'hono/factory';
import { createRouter, jsonResponse } from 'hono-typed-router';
import type { RouteMiddlewareFactory } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';
import { allowRequest } from '../services';
import type { SessionVars } from './middleware';
import { ErrorBody } from './schemas';

const scopeMiddleware = createScopeMiddleware<SessionVars>({
  resolve: (c) => c.var.session.scopes,
});

const rateLimitMiddleware: RouteMiddlewareFactory = (route, meta) =>
  createMiddleware<{ Variables: SessionVars }>(async function rateLimit(c, next) {
    const key = `${c.var.session.userId}:${route.operationId ?? meta.path}`;
    const limitPerMinute = route.method === 'get' ? 120 : 20;
    if (!(await allowRequest(key, limitPerMinute))) {
      return c.json({ error: 'RATE_LIMITED' }, 429);
    }
    await next();
  });

export const makeRouter = createRouter({
  routeDefaults: {
    responses: {
      401: jsonResponse(ErrorBody, 'Unauthorized'),
      403: jsonResponse(ErrorBody, 'Forbidden'),
      404: jsonResponse(ErrorBody, 'Not found'),
      429: jsonResponse(ErrorBody, 'Too many requests'),
    },
  },
  transformRoute: (config, meta) => ({
    ...config,
    operationId:
      config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
  }),
  routeMiddleware: [scopeMiddleware, rateLimitMiddleware],
});
```

`routeDefaults` declares each status that a middleware or an error arm returns. `transformRoute` derives an `operationId` from `meta.path`, for example `get_api_organizations_organizationId_things_id`. The middlewares of the route middleware factories run after all the context middlewares, so `c.var.session` is set.

#### `src/api/index.ts`

This file declares the root context and the outer `server`:

```ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { defineRootContext, mountRouter } from 'hono-typed-router';
import { requireSession, trackRequest } from './middleware';
import { organizationRouter } from './organizations/[organizationId]';

export const apiContext = defineRootContext('/api')
  .middleware(trackRequest)
  .middleware(requireSession);

const app = mountRouter(apiContext, [organizationRouter]);

export const server = new OpenAPIHono().route('/', app);

server.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));
server.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Things API', version: '1.0.0' } });
server.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
  type: 'http',
  scheme: 'bearer',
});
```

`requireSession` runs on every path under `/api`. For this reason, `server` serves the OpenAPI document outside `/api`. `server.notFound` sends the 404 response of `.bind()`.

#### `src/api/organizations/[organizationId]/index.ts`

This file loads the organization for this route and for each route under it:

```ts
import { defineChildContext, jsonResponse } from 'hono-typed-router';
import { findOrganization } from '../../../services';
import type { apiContext } from '../..';
import { makeRouter } from '../../router';
import { Organization } from '../../schemas';
import { thingsRouter } from './things';

export const organizationContext = defineChildContext<typeof apiContext>()(
  '/organizations/:organizationId',
).bind('organization', 'organizationId', (id, c) => findOrganization(id, c.var.session.userId));

export const organizationRouter = makeRouter(
  organizationContext,
  ({ app, defineRoute }) => {
    const getOrganizationRoute = defineRoute('get', {
      responses: { 200: jsonResponse(Organization, 'The organization') },
    });

    return app.openapi(getOrganizationRoute, (c) => c.json(c.var.organization, 200));
  },
  [thingsRouter],
);
```

`findOrganization` returns `null` when the user is not a member. Then `.bind()` calls `c.notFound()`, and the route does not run.

#### `src/api/organizations/[organizationId]/things/index.ts`

This file has the collection routes:

```ts
import { z } from 'zod';
import { defineChildContext, jsonRequest, jsonResponse } from 'hono-typed-router';
import { createThing, listThings } from '../../../../services';
import { makeRouter } from '../../../router';
import { CreateThing, Thing } from '../../../schemas';
import type { organizationContext } from '..';
import { thingByIdRouter } from './[id]';

export const thingsContext = defineChildContext<typeof organizationContext>()('/things');

export const thingsRouter = makeRouter(
  thingsContext,
  ({ app, defineRoute }) => {
    const listThingsRoute = defineRoute('get', {
      responses: { 200: jsonResponse(z.array(Thing), 'The things of the organization') },
    });
    const createThingRoute = defineRoute('post', {
      request: jsonRequest(CreateThing, 'The new thing'),
      responses: { 201: jsonResponse(Thing, 'The created thing') },
      security: [{ bearer: ['things:write'] }],
    });

    return app
      .openapi(listThingsRoute, async (c) => c.json(await listThings(c.var.organization.id), 200))
      .openapi(createThingRoute, async (c) => {
        const { organization, session } = c.var;
        const thing = await createThing(organization.id, session.userId, c.req.valid('json'));
        c.var.log(`created thing ${thing.id}`);
        return c.json(thing, 201);
      });
  },
  [thingByIdRouter],
);
```

Only the `POST` route has `security`. Thus only this route gets a scope middleware.

#### `src/api/organizations/[organizationId]/things/[id].ts`

This file has the item route. It is a leaf, so it has no children:

```ts
import { defineChildContext, handle, jsonResponse, matchErrors } from 'hono-typed-router';
import { findThing, ThingNotFound } from '../../../../services';
import { makeRouter } from '../../../router';
import { Thing } from '../../../schemas';
import type { thingsContext } from '.';

export const thingByIdContext = defineChildContext<typeof thingsContext>()('/:id');

const thingNotFoundArms = matchErrors([ThingNotFound], {
  ThingNotFound: (_error, c) => c.json({ error: 'NOT_FOUND' }, 404),
});

export const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
  const getThingRoute = defineRoute('get', {
    responses: { 200: jsonResponse(Thing, 'The thing') },
  });

  return app.openapi(getThingRoute, (c) =>
    handle(
      c,
      async ({ param }) => c.json(await findThing(c.var.organization.id, param.id), 200),
      thingNotFoundArms,
    ),
  );
});
```

`param` has the type `{ organizationId: string; id: string }`. The `404` response of `routeDefaults` makes `thingNotFoundArms` correct. Without the `404` response, the handler that uses `thingNotFoundArms` is a compile error.

#### `src/api/index.test.ts`

This file calls `server` in-process. In this test, `verifySession` accepts two tokens: `reader-token` without scopes, and `writer-token` with the `things:write` scope:

```ts
import { testClient } from 'hono/testing';
import { expect, it } from 'vitest';
import { server } from '.';

const client = testClient(server);
const organization = client.api.organizations[':organizationId'];
const param = { organizationId: 'org-1' };
const reader = { headers: { authorization: 'Bearer reader-token' } };
const writer = { headers: { authorization: 'Bearer writer-token' } };

it('returns the organization of a member', async () => {
  const res = await organization.$get({ param }, reader);

  expect(res.status).toBe(200);
});

it('returns 401 without a token', async () => {
  const res = await organization.things.$get({ param });

  expect(res.status).toBe(401);
  expect(res.headers.get('x-request-id')).toBeTruthy();
});

it('returns 403 when the session has no things:write scope', async () => {
  const res = await organization.things.$post({ param, json: { name: 'Widget' } }, reader);

  expect(res.status).toBe(403);
});

it('returns 404 for an unknown thing', async () => {
  const res = await organization.things[':id'].$get({ param: { ...param, id: 'missing' } }, reader);

  expect(res.status).toBe(404);
  if (res.status === 404) {
    expect(await res.json()).toEqual({ error: 'NOT_FOUND' });
  }
});

it('creates a thing', async () => {
  const res = await organization.things.$post({ param, json: { name: 'Widget' } }, writer);

  expect(res.status).toBe(201);
  if (res.status === 201) {
    expect((await res.json()).name).toBe('Widget');
  }
});
```

In each file, TypeScript knows the types of `c.var.session`, `c.var.log`, and `c.var.organization`. The types come from `typeof apiContext` through the curried contexts.

A test can call the router of a curried child directly, for example `thingByIdRouter()`. Then `meta.path` starts at the segment of the child (`/:id`), and the derived `operationId` changes. The API reference section [`transformRoute`](./api.md#createrouteroptions) shows how to keep it stable.

### Children

Each file builds its router with `makeRouter(context, callback, children)`. These rules apply:

- A node that declares no routes uses `makeRouter(context, () => {}, children)`.
- The root uses `mountRouter(context, children)`. It returns the app.
- Hono matches routes in registration order. Thus, put children with literal segments (`/stats`) before children with params (`/:id`). The router throws a `TypeError` for a param child before a literal sibling. It accepts the order only when three conditions are true. The subtree of the param child has no middleware of its own. It has no raw routes, such as `app.get(...)`. It has no route that overlaps a route of the sibling with the same method. `HEAD` counts as `GET`, and `ALL` counts as every method. The router does not check a child at `/:id` before a child at `/:id/settings`.
- If a file mounts more than one child, give the array a name with `as const`:

```ts
const thingsChildren = [statsRouter, thingByIdRouter] as const;

export const thingsRouter = makeRouter(thingsContext, () => {}, thingsChildren);
```

### Why this layout

- TypeScript checks the URL hierarchy. If a file imports the context of the wrong parent, its path type is wrong. The error shows where its routes use path params.
- At runtime, nothing checks a curried child under the wrong router. The child then serves at the wrong URL.
- A new endpoint is a new file. Its parent adds the router to its `children` array.
- The file tree follows the URL. A search for `[organizationId]/things` finds every route under that path.
- `c.var` has the correct type at every depth. No file declares the vars of its parents.

The other examples of this guide declare all their contexts in one file. In a real project, put each context in its own file.

## A complete CRUD resource

This resource has a collection context and an item context. In the project layout, they are `src/api/things/index.ts` and `src/api/things/[id].ts`. This example declares them in one file:

```ts
import { z } from 'zod';
import {
  createRouter,
  defineChildContext,
  defineRootContext,
  emptyResponse,
  jsonRequest,
  jsonResponse,
  mountRouter,
} from 'hono-typed-router';

const Thing = z.object({ id: z.string(), name: z.string() });
const CreateThing = z.object({ name: z.string().min(1) });

const apiContext = defineRootContext('/api');
const thingsContext = defineChildContext(apiContext, '/things');
const thingByIdContext = defineChildContext(apiContext, '/things/:id').bind('thing', 'id', (id) =>
  db.things.find(id),
);

const makeRouter = createRouter();

const thingsRouter = makeRouter(thingsContext, ({ app, defineRoute }) => {
  const listThingsRoute = defineRoute('get', {
    responses: { 200: jsonResponse(z.array(Thing), 'List of things') },
  });
  const createThingRoute = defineRoute('post', {
    request: jsonRequest(CreateThing, 'Create a thing'),
    responses: { 201: jsonResponse(Thing, 'Created') },
  });

  return app
    .openapi(listThingsRoute, async (c) => c.json(await db.things.list(), 200))
    .openapi(createThingRoute, async (c) =>
      c.json(await db.things.create(c.req.valid('json')), 201),
    );
});

const thingByIdRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
  const getThingRoute = defineRoute('get', {
    responses: {
      200: jsonResponse(Thing, 'A thing'),
      404: emptyResponse('Not found'),
    },
  });
  const deleteThingRoute = defineRoute('delete', {
    responses: { 204: emptyResponse('Deleted') },
  });

  return app
    .openapi(getThingRoute, (c) => c.json(c.var.thing, 200))
    .openapi(deleteThingRoute, async (c) => {
      await db.things.delete(c.var.thing.id);
      return c.body(null, 204);
    });
});

const app = mountRouter(apiContext, [thingsRouter, thingByIdRouter]);
```

`.bind()` loads the thing for each route under `/things/:id`. If `db.things.find` returns `null`, the request gets the 404 response of `app.notFound`, and the handler does not run. The `404` response of `getThingRoute` describes the 404 of `.bind()` in the OpenAPI document and in the client type.

The item context is a sibling of the collection. It inherits nothing from the collection. If the item must inherit the middlewares of the collection, make it a child.

Each callback returns its chain of `.openapi()` calls. The README [Quick start](../README.md#quick-start) gives the reason.

## Path params

`defineRoute` takes the params from the full path of the context. A route does not declare them. The handler reads them with their types, the validator checks them, and the OpenAPI document lists them:

```ts
const apiContext = defineRootContext('/api');
const thingByIdContext = defineChildContext(apiContext, '/things/:id');
const noteContext = defineChildContext(thingByIdContext, '/notes/:noteId?');

const Note = z.object({ thingId: z.number(), noteId: z.string().optional() });

const notesRouter = makeRouter(noteContext, ({ app, defineRoute }) => {
  const getNoteRoute = defineRoute('get', {
    request: { params: z.object({ id: z.coerce.number() }) },
    responses: { 200: jsonResponse(Note, 'The note') },
  });

  return app.openapi(getNoteRoute, (c) => {
    const { id } = c.req.valid('param');
    const noteId = c.req.param('noteId');
    return c.json({ thingId: id, noteId }, 200);
  });
});
```

The declared `z.object` changes the type of `id` to `number`. `defineRoute` does not add the optional `noteId`. Thus the handler reads it with `c.req.param('noteId')`, as `string | undefined`. The API reference section [`defineRoute`](./api.md#makeroutercontext-callback-children) gives all the rules for path params.

## Nesting children

A child context can have children. Each level keeps the path and the vars of the levels above it:

```ts
const apiContext = defineRootContext('/api');
const organizationContext = defineChildContext(apiContext, '/organizations/:organizationId');
const departmentsContext = defineChildContext(organizationContext, '/departments');

const departmentsRouter = makeRouter(departmentsContext, ({ app, defineRoute }) => {
  const listDepartmentsRoute = defineRoute('get', {
    responses: { 200: jsonResponse(z.array(Department), 'OK') },
  });

  return app.openapi(listDepartmentsRoute, async (c) =>
    c.json(await db.departments.listFor(c.req.param('organizationId')), 200),
  );
});

const organizationRouter = makeRouter(organizationContext, () => {}, [departmentsRouter]);
const app = mountRouter(apiContext, [organizationRouter]);
```

The path of `departmentsContext` is `/api/organizations/:organizationId/departments`, in the type and at runtime. `organizationContext` has no routes of its own. But a parent needs its router, so it uses `makeRouter(context, () => {}, children)`. The root uses `mountRouter`, which returns the app.

## Reusing context middleware across children

Load the parent resource one time, and give it to all the children. `.bind()` loads a value from a path param and sets it as a var. This example uses `requireSession` from [`src/api/middleware.ts`](#srcapimiddlewarets):

```ts
const apiContext = defineRootContext('/api').middleware(requireSession);
const organizationContext = defineChildContext(apiContext, '/organizations/:organizationId').bind(
  'organization',
  'organizationId',
  (id) => db.organizations.find(id),
);

const departmentsRouter = makeRouter(
  defineChildContext(organizationContext, '/departments'),
  ({ app, defineRoute }) => {
    const listDepartmentsRoute = defineRoute('get', {
      responses: { 200: jsonResponse(z.array(Department), 'OK') },
    });

    return app.openapi(listDepartmentsRoute, async (c) => {
      const { organization, session } = c.var;
      return c.json(await db.departments.listFor(organization.id, session.userId), 200);
    });
  },
);
```

The handler reads `organization` and `session` from `c.var`, with their types. If `db.organizations.find` returns `null`, the request gets the 404 response of `app.notFound`. The API reference section [`.bind()`](./api.md#bindkey-param-load) gives all the rules of `.bind()`.

A reusable middleware that reads vars uses `ContextEnv<typeof context, NewVars>`. It fits `context` and each descendant that has more vars:

```ts
import type { ContextEnv } from 'hono-typed-router';

interface MembershipVars {
  membership: Membership;
}

const loadMembership = createMiddleware<ContextEnv<typeof organizationContext, MembershipVars>>(
  async function loadMembership(c, next) {
    c.set('membership', await db.memberships.find(c.var.organization.id, c.var.session.userId));
    await next();
  },
);

const departmentsContext = defineChildContext(organizationContext, '/departments').middleware(
  loadMembership,
);
```

`loadMembership` reads `session` and `organization`, and sets `membership`. `departmentsContext` adds only `membership`. These errors can occur:

- If the context does not have a var that the middleware reads, the error is `This middleware reads vars that the context does not have: <key>`.
- If the middleware sets a var that the context has, the error is `Cannot redeclare existing var: <key>. Use another var name, or read <key> from the context.`

## Serving the app (Node, Bun, Cloudflare Workers)

`mountRouter(...)` and `makeRouter(...)()` return an `OpenAPIHono` instance. Serve it as any Hono app.

For Node:

<!-- doc-check: skip -->

```ts
import { serve } from '@hono/node-server';

serve({ fetch: app.fetch, port: 3000 });
```

For Bun:

<!-- doc-check: skip -->

```ts
Bun.serve({ fetch: app.fetch });
```

For Cloudflare Workers:

<!-- doc-check: skip -->

```ts
export default { fetch: app.fetch };
```

### Cloudflare bindings

The bindings of a Worker are the type of `c.env`. Declare them on the root context. Give them as the third type argument of `defineRootContext`. Children get the bindings of their parent. Then `c.env.DB` has a type in each route handler:

```ts
interface Env {
  Bindings: { DB: D1Database };
}

const workerContext = defineRootContext<'/api', {}, Env['Bindings']>('/api');
const statsResponse = jsonResponse(z.object({ users: z.number() }), 'User count');

const statsRouter = makeRouter(
  defineChildContext(workerContext, '/stats'),
  ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: statsResponse } }), async (c) => {
      const users = await c.env.DB.prepare('SELECT count(*) AS n FROM users').first<number>('n');

      return c.json({ users: users ?? 0 }, 200);
    }),
);

const app = mountRouter(workerContext, [statsRouter]);
```

Export `app` as in the Cloudflare Workers example above. A middleware typed `createMiddleware<Env>` in the root array also gives the bindings to the context. Without bindings, `c.env` is `unknown`.

## Exposing the OpenAPI document and Swagger UI

The middlewares of the root context run for each route of `app`. The base path of the root context, for example `/api`, also applies. Thus `app.doc('/openapi.json', ...)` serves the document at `/api/openapi.json`, behind the session middleware. Instead, mount `app` on an outer `OpenAPIHono`. Then register the document and the UIs on the outer app. The outer app gets the routes and the OpenAPI data of `app`. Serve `server`, not `app`:

<!-- doc-check: skip -->

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

## Middleware for every route with route middleware factories

Register the route middleware factories one time on the router maker, in `routeMiddleware`. The router maker calls each factory for every declared route, with the resolved `RouteConfig`. This router maker has three factories:

- `scopeMiddleware` checks the scopes that a route declares in `security`.
- `requestLogMiddleware` logs each request with the data of its route.
- `operationIdHeaderMiddleware` sets the `X-Operation-Id` header.

```ts
import type { RouteMiddlewareFactory } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';

const scopeMiddleware = createScopeMiddleware<SessionVars>({
  resolve: (c) => c.var.session.scopes,
});

const requestLogMiddleware: RouteMiddlewareFactory = (route) =>
  async function logRequest(c, next) {
    const start = Date.now();
    await next();
    logger.info({
      method: route.method,
      tags: route.tags,
      status: c.res.status,
      ms: Date.now() - start,
    });
  };

const operationIdHeaderMiddleware: RouteMiddlewareFactory = (route) =>
  async function setOperationIdHeader(c, next) {
    await next();
    if (route.operationId) c.header('X-Operation-Id', route.operationId);
  };

const makeRouter = createRouter({
  routeMiddleware: [scopeMiddleware, requestLogMiddleware, operationIdHeaderMiddleware],
});
```

`defineRoute` calls the route middleware factories in array order. `app.openapi` attaches their middlewares when it registers the route. At request time, the middlewares run in the same order. A factory returns `undefined` for a route that needs no middleware. `createScopeMiddleware` does this for a route without `security`. At request time, `routePath(c)` from `hono/route` gives the full matched path of the route.

## Scope checks with `createScopeMiddleware`

A frequent route middleware factory enforces OAuth-style scopes that a route declares in its `security`. `createScopeMiddleware` from `hono-typed-router/scopes` makes it. It returns a route middleware factory, not a middleware. Give it to `createRouter({ routeMiddleware })`, not to `.middleware()`:

```ts
import { createRouter } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';

const scopeMiddleware = createScopeMiddleware<SessionVars>({
  resolve: (c) => c.var.session.scopes,
  onForbidden: (missing, c) => ({ code: 'FORBIDDEN', missing, userId: c.var.session.userId }),
});

const makeRouter = createRouter({ routeMiddleware: scopeMiddleware });
```

`SessionVars` gives the type of `c.var` in `resolve` and in `onForbidden`. The `onForbidden` option is optional. It returns the body of the 403 response.

Give the vars that the context middlewares set before the route middleware runs. You can also give a context. Then `c.var` has the vars of that context:

```ts
const sessionContext = defineRootContext('/api').middleware<SessionVars>(
  async function loadSession(c, next) {
    c.set('session', await readSession(c));
    await next();
  },
);

const contextScopeMiddleware = createScopeMiddleware(sessionContext, {
  resolve: (c) => c.var.session.scopes,
});
```

Without a type argument or a context, `c.var` has no vars. Then `c.var.session` is a compile error. The library does not compare the vars of `createScopeMiddleware` with the contexts of the routes.

These rules apply:

- The factory extracts the required scopes from every entry in `route.security`. It flattens them across schemes and removes duplicates.
- If `route.security` is absent or empty, the factory returns `undefined`. The route then has no scope middleware.
- If one or more required scopes are missing from `resolve(c)`, the middleware returns 403 with the configured body.

### Custom route middleware with `createMiddleware`

You can write your own route middleware factory, for example for an audit log or a rate limit. Build the middleware with `createMiddleware` from `hono/factory`. The factory reads the config of the route (`route.method`, `route.operationId`, `route.security`) and `meta.path` one time, at route declaration:

```ts
import { createMiddleware } from 'hono/factory';
import { createRouter } from 'hono-typed-router';
import type { RouteMiddlewareFactory } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';

interface SessionVars {
  session: { userId: string; scopes: string[] };
}

const auditMiddleware: RouteMiddlewareFactory = (route, meta) =>
  createMiddleware<{ Variables: SessionVars }>(async function audit(c, next) {
    await next();
    await auditLog.write({
      userId: c.var.session.userId,
      operation: route.operationId ?? `${route.method} ${meta.path}`,
      status: c.res.status,
    });
  });

const makeRouter = createRouter({
  routeMiddleware: [
    createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes }),
    auditMiddleware,
  ],
});
```

The type argument of `createMiddleware` gives a typed `c.var.session`. You can also use `ContextEnv<typeof apiContext>` to read the vars of a context. But the factory returns an untyped `MiddlewareHandler`. The router does not compare this type with the vars of its context. Use the factory only with routers whose contexts set these vars.

## Middleware for a single route

`defineRoute()` accepts the native `middleware` key of `@hono/zod-openapi`. Put a middleware that only one route needs in the config of that route. It runs after the middlewares of the route middleware factories, and before the validators. The README section [Which middleware to use](../README.md#which-middleware-to-use) gives the full run order.

```ts
import type { ContextEnv } from 'hono-typed-router';

interface UploadVars {
  uploadQuota: number;
}

const loadQuota = createMiddleware<ContextEnv<typeof apiContext, UploadVars>>(
  async function loadQuota(c, next) {
    c.set('uploadQuota', await quotas.remaining(c.var.session.userId));
    await next();
  },
);
```

`loadQuota` reads `c.var.session` from `apiContext`, and sets `uploadQuota`. Use it in a router built from `apiContext`:

```ts
const uploadsRouter = makeRouter(apiContext, ({ app, defineRoute }) => {
  const uploadFileRoute = defineRoute('post', {
    middleware: loadQuota,
    request: jsonRequest(UploadBody, 'The file'),
    responses: { 201: jsonResponse(Upload, 'Uploaded') },
  });

  return app.openapi(uploadFileRoute, async (c) =>
    c.json(await uploads.save(c.req.valid('json'), c.var.uploadQuota), 201),
  );
});
```

The `middleware` key also accepts an array literal, such as `[a, b]`. The handler sees `c.var.uploadQuota` as `number`, together with the vars of the context. The API reference section [`defineRoute`](./api.md#makeroutercontext-callback-children) gives the type rules of the `middleware` key.

## Sharing `routeDefaults` across every route

`routeDefaults` is a partial `RouteConfig`. The router maker deep-merges it into every route that it declares. Use it for a shared `401`, `403`, or `422` response, for a default `security`, or for default `tags`. The API reference section [`createRouter`](./api.md#createrouteroptions) gives the merge rules.

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

const thingsRouter = makeRouter(thingsContext, ({ app, defineRoute }) => {
  const RouteValidation = z.object({ code: z.literal('NAME_TOO_LONG') });

  const createThingRoute = defineRoute('post', {
    tags: ['things'],
    request: jsonRequest(CreateThing, 'Create a thing'),
    responses: {
      201: jsonResponse(Thing, 'Created'),
      422: jsonResponse(RouteValidation, 'Validation error (route)'),
    },
  });

  return app.openapi(createThingRoute, async (c) =>
    c.json(await db.things.create(c.req.valid('json')), 201),
  );
});
```

The merged `tags` are `['v1', 'things']`. The route gets the `401` and `403` responses of `routeDefaults`. The `422` schema becomes `ZodUnion<readonly [BaseValidation, RouteValidation]>`, in the type and at runtime. Thus the handler must return a body that agrees with `201`, `401`, `403`, or `422`. If a returned body does not agree with its status, TypeScript shows an error.

## Changing every route config with `transformRoute`

`transformRoute` is a hook of the form `(config: RouteConfig, meta: RouteMeta) => RouteConfig`. It runs after `createRoute()` and after the `routeDefaults` merge. Then the route middleware factories get the config. The hook does not change the static type that `defineRoute()` returns. Use it only for changes at runtime.

```ts
const makeRouter = createRouter({
  transformRoute: (config) => ({
    ...config,
    summary: config.summary ?? config.operationId,
    tags: [...new Set([...(config.tags ?? []), config.method === 'get' ? 'read' : 'write'])],
  }),
});
```

Return `{ ...config, ... }` from the hook. A hook that builds a new object without the keys of `config` removes them. For example, the route then loses its `middleware` key, and these middlewares do not run.

### Deriving `operationId` from the path

`config.path` is relative to the router, usually `'/'`, so it is not unique. Use `meta.path`, the full mount path of the router joined with `config.path`. Replace the characters that are not valid in an identifier:

```ts
const makeRouter = createRouter({
  transformRoute: (config, meta) => ({
    ...config,
    operationId:
      config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
  }),
});
```

For `GET /api/things/:id`, the `operationId` is `get_api_things_id`. `meta.path` uses the `:param` syntax of Hono, not the `{param}` syntax of OpenAPI. When a parent mounts the router, `meta.path` is the full URL path. This is true for the value form and for the curried form. If you call the router of a curried child directly, `meta.path` starts at the segment of that child.

These are frequent uses of `transformRoute`:

- Set a default `summary` from the `operationId` of the route.
- Add a tag for the environment: `tags: [...(route.tags ?? []), process.env.STAGE]`.
- Add a default scheme to each `security` entry.

## Opting a route out of the default security

There are two ways to make a public route when `routeDefaults` sets a `security` requirement.

### Set `security: []` on the route

A route with `security: []` opts out of the `security` of `routeDefaults`. The merged `security` is `[]`, also in the static type of `defineRoute()`. Thus `createScopeMiddleware` does not check scopes, and the OpenAPI operation is public. This rule applies only to `security`. `tags: []` and other empty arrays still merge with `routeDefaults`.

```ts
const makeRouter = createRouter({
  routeDefaults: { security: [{ bearer: ['things:read'] }] },
  routeMiddleware: createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes }),
});

const apiRouter = makeRouter(apiContext, ({ app, defineRoute }) => {
  const getHealthRoute = defineRoute('get', { security: [], responses: { 200: okResponse } });
  const listThingsRoute = defineRoute('get', { responses: { 200: okResponse } });

  return app
    .openapi(getHealthRoute, (c) => c.json({ ok: true }, 200))
    .openapi(listThingsRoute, (c) => c.json({ ok: true }, 200));
});
```

`getHealthRoute` is public. `listThingsRoute` gets `routeDefaults.security`, so it requires `things:read`.

### Make a second router maker for public routes

If a subtree needs different route middleware factories, use a second router maker. If a route middleware factory does not read `security`, also use one.

```ts
const makeAuthedRouter = createRouter({ routeMiddleware: scopeMiddleware });
const makePublicRouter = createRouter();

const healthRouter = makePublicRouter(
  defineChildContext(apiContext, '/health'),
  ({ app, defineRoute }) =>
    app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
      c.json({ ok: true }, 200),
    ),
);
const thingsRouter = makeAuthedRouter(
  defineChildContext(apiContext, '/things'),
  ({ app, defineRoute }) =>
    app.openapi(
      defineRoute('get', {
        security: [{ bearer: ['things:read'] }],
        responses: { 200: okResponse },
      }),
      (c) => c.json({ ok: true }, 200),
    ),
);

const app = mountRouter(apiContext, [healthRouter, thingsRouter]);
```

Each child keeps the options of the router maker that made it.

## Custom error bodies from middleware

When the middleware of a route middleware factory returns a `Response`, the chain stops. Use this for expected rejections, such as 403 or 429. For real errors, throw. Then `app.onError` formats them in one place.

```ts
const rateLimitMiddleware =
  (limiter: Limiter): RouteMiddlewareFactory =>
  () =>
    async function rateLimit(c, next) {
      const verdict = await limiter.check(c.req.header('x-api-key') ?? '');
      if (!verdict.allowed) {
        return c.json({ error: 'RATE_LIMITED', retryAfterSeconds: verdict.retryAfter }, 429, {
          'Retry-After': String(verdict.retryAfter),
        });
      }
      await next();
    };

const makeRouter = createRouter({
  routeMiddleware: [rateLimitMiddleware(globalLimiter)],
});
```

## Type-safe error handling in handlers

Route middleware factories do the checks that apply to many routes. `handle(c, fn, arms)` maps the errors that one handler throws to responses. The responses of the arms must agree with the `responses` of the route.

TypeScript cannot infer what a function throws. Thus you list the error classes that a route maps, and `matchErrors` gives you one handler for each class. The key of each handler is the literal `_tag` of its class, or else its literal `name`:

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

const MessageBody = z.object({ message: z.string() });

const thingArms = matchErrors([ThingNotFound, SlugTaken], {
  ThingNotFound: (_error, c) => c.json({ message: 'Thing not found' }, 404),
  SlugTaken: (error, c) => c.json({ message: `Slug already taken: ${error.slug}` }, 409),
});

const getThingRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
  const getThingRoute = defineRoute('get', {
    responses: {
      200: jsonResponse(Thing, 'The thing'),
      404: jsonResponse(MessageBody, 'Not found'),
      409: jsonResponse(MessageBody, 'Conflict'),
    },
  });

  return app.openapi(getThingRoute, (c) =>
    handle(c, async ({ param: { id } }) => c.json(await thingsRepo.findOrFail(id), 200), thingArms),
  );
});
```

`thingArms` is a constant, so more than one route can use it. If you remove `404` or `409` from `responses`, the handler is a compile error. The handler map is exhaustive: a missing key, an extra key, or two classes with the same tag is a compile error. The `Context` of an arm is not typed with the vars of the route, so read route vars from the outer `c`.

`onError(ErrorClass, handler)` makes one arm for one class. Use it for a class without a literal tag, such as the error of a library. Also use it to decide, for each error, whether the arm handles it. Spread `matchErrors(...)` next to it:

```ts
export const recordNotFoundArm = (message: string) =>
  onError(RecordNotFoundError, (_err, c) => c.json({ message }, 404));

const updateThingRouter = makeRouter(thingByIdContext, ({ app, defineRoute }) => {
  const updateThingRoute = defineRoute('put', {
    request: jsonRequest(CreateThing, 'The new name'),
    responses: {
      200: jsonResponse(Thing, 'The thing'),
      404: jsonResponse(MessageBody, 'Not found'),
      409: jsonResponse(MessageBody, 'Conflict'),
    },
  });

  return app.openapi(updateThingRoute, (c) =>
    handle(c, async ({ param: { id }, json }) => c.json(await thingsRepo.update(id, json), 200), [
      ...matchErrors([SlugTaken], {
        SlugTaken: (e, ec) => ec.json({ message: `Slug already taken: ${e.slug}` }, 409),
      }),
      onError(UniqueConstraintError, (err, ec) => {
        if (!err.columns.includes('slug')) return rethrow();
        return ec.json({ message: 'Slug already taken' }, 409);
      }),
      recordNotFoundArm('Thing not found'),
    ]),
  );
});
```

The arms run in order. `rethrow()` gives the error to the next arm. If no arm handles it, `handle` throws the error again. For the dispatch without the input proxy, use `handleErrors(body, arms, c)`. It has the same behavior and the same return type. Put common arms, such as `recordNotFoundArm` and `uniqueViolationArm`, into helpers that call `onError`.

The client types that `hc` and `testClient` see come from the `responses` of the route, not from the handler. The API reference section [Error handling](./api.md#error-handling) gives all the rules of `handle`, `matchErrors`, `onError`, and `rethrow()`.

## Adding custom builders with `extendRouteContext`

`.bind()` covers the common case: it loads one value from a path param. For other context builders, use `extendRouteContext`. It adds custom builder methods to `defineRootContext` and `defineChildContext`. Each method keeps the path of the context and its vars. The library adds the builders again after `.middleware()`, `.bind()`, and each builder. As a result, a chain never loses the builders.

Describe the extended context as a self-referential interface that extends `RouteContextBase`. Pair it with a one-line `RouteContextKind`. Then pass the kind as the type argument, and the runtime builders as the argument:

```ts
import { extendRouteContext } from 'hono-typed-router';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from 'hono-typed-router';
import type { MiddlewareHandler } from 'hono';
import type { ParamKeys } from 'hono/types';

interface Ctx<TPath extends string, TVars extends object> extends RouteContextBase<
  CtxKind,
  TPath,
  TVars
> {
  bindRepository: <TKey extends string, TRepo>(
    key: TKey extends keyof TVars
      ? `Cannot redeclare existing var: "${TKey}". Use another var name, or read "${TKey}" from the context.`
      : TKey,
    param: ParamKeys<TPath>,
    repository: () => TRepo,
  ) => ReaugmentContext<CtxKind, TPath, TVars & { [K in TKey]: RelationsFor<TRepo> }>;
}
interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

const { defineRootContext, defineChildContext } = extendRouteContext<CtxKind>({
  bindRepository: (context) => (key, param, repository) => {
    const mw: MiddlewareHandler = async (c, next) => {
      c.set(key, relationsFor(repository(), c.req.param(param)));
      await next();
    };
    return context.middleware(mw);
  },
});

const organizationContext = defineChildContext(
  apiContext,
  '/organizations/:organizationId',
).bindRepository('organization', 'organizationId', () => organizationsRepository);
```

`organizationContext.vars.organization` has a type. `bindRepository` and `.middleware()` stay available on `organizationContext`.

You can chain more than one builder, and `.middleware()` after them:

```ts
const teamContext = defineChildContext(apiContext, '/organizations/:organizationId/teams/:teamId')
  .bindRepository('organization', 'organizationId', () => organizationsRepository)
  .bindRepository('team', 'teamId', () => teamsRepository)
  .middleware<{ membership: Membership }>(async function loadMembership(c, next) {
    c.set('membership', await findMembership(c.var.organization, c.var.team));
    await next();
  });
```

Each step sees the vars of the steps before it. A second `bindRepository` with the same key is a compile error. `param` must be a parameter of the path of the context. The extended `defineChildContext` has the same value form and curried form as the base one. The API reference section [`extendRouteContext`](./api.md#extendroutecontextkbuilders) gives the types.

## Testing a router

Use `testClient` from `hono/testing`. It calls the app in-process, with the same typed client as `hc`. The paths, the params, the request bodies, and the response bodies have the types of the routes. You do not need a server. Build the client from the root app. The routes of the children are part of its type. This test uses the app of [A complete CRUD resource](#a-complete-crud-resource):

```ts
import { testClient } from 'hono/testing';
import { expect, it } from 'vitest';

const app = mountRouter(apiContext, [thingsRouter, thingByIdRouter]);
const client = testClient(app);

it('creates a thing', async () => {
  const res = await client.api.things.$post({ json: { name: 'Widget' } });

  expect(res.status).toBe(201);
  if (res.status === 201) {
    const thing = await res.json();
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

The `json` argument must agree with the body schema of the route, so `{}` is a compile error. To send headers, use the second argument: `client.api.things.$post({ json }, { headers: { authorization: 'Bearer …' } })`. The [project layout](#srcapiindextestts) has a test file for the complete example.

After a check of `res.status`, `res.json()` has the type of the response with that status. These rules apply:

- The app of a child router alone, as in `testClient(thingByIdRouter())`, has full-path types. But it serves its routes at its own segment, without the middlewares of the parent.
- A status that a route middleware returns, such as the 403 from `createScopeMiddleware`, has a type only if the route or `routeDefaults` declares it.
- A children array in a plain variable is a compile error. See [`makeRouter`](./api.md#makeroutercontext-callback-children).
- If two routes declare the same method and path, the router throws a `TypeError` when it runs. Without this error, the client type for that path is `never`, or a false merge of the two bodies. Paths that differ only in the names of their params, such as `/a/:id` and `/a/:x`, are duplicates.
- Without children, a callback that returns an app with no typed routes is a compile error. See the README [Quick start](../README.md#quick-start).

`OpenAPIHono` also has `.request(path, init?)`. It is an untyped fetch call against the in-process app. Use it to send a request that the typed client cannot send, such as malformed JSON:

```ts
const res = await app.request('/api/things', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{',
});

expect(res.status).toBe(400);
```

## Composing with regular Hono middleware

Add a middleware for the whole app, such as CORS or a logger, to the outer app before `.route('/', app)`. You can also put it in the `defineRootContext` array. `app.use(...)` after `mountRouter(...)` or `makeRouter(...)()` does not run for the routes that are already registered:

```ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

export const server = new OpenAPIHono()
  .use('*', logger())
  .use('/api/*', cors({ origin: 'https://example.com' }))
  .route('/', app);
```

The middlewares of the outer app run before all the middlewares of the contexts. They also run for the OpenAPI document and for unknown paths. The README section [Which middleware to use](../README.md#which-middleware-to-use) compares the five ways to add middleware.

## Observability

### Name your route middleware factories

The `showRoutes(app, { verbose: true })` and `inspectRoutes` functions of `hono/dev` show a middleware by its function name. Stack traces also show it by this name. An inline arrow that a route middleware factory returns has no name. Return a named function expression instead, or set the name with `Object.defineProperty(fn, 'name', { value: '...' })`:

```ts
const makeRouter = createRouter({
  routeMiddleware: (route) =>
    async function auditLog(c, next) {
      await next();
      console.info(route.method, c.res.status);
    },
});
```

`createScopeMiddleware` already names its middleware, for example `requireScopes:things.read`. A route without `security` has no scope middleware, so `showRoutes` shows no `requireScopes` entry for it.

`createMiddleware` from `hono/factory` returns the function that you give it. To name the middleware, give `createMiddleware` a named function, for example `createMiddleware(async function auditLog(c, next) { ... })`.

### Report the declared route to OpenTelemetry

`@hono/otel` gets the span name from the handler that ran when the app produced the response. A context middleware is registered on the whole subtree. If it returns a 401, the span reads `GET /api/things/*` instead of `GET /api/things`. Instead, take the first matched route that is not a subtree middleware. `getRoute` needs `@hono/otel` 1.2.0 or later. Register the instrumentation before you mount routes, because Hono runs middleware in registration order:

<!-- doc-check: skip -->

```ts
import { httpInstrumentationMiddleware } from '@hono/otel';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { matchedRoutes, routePath } from 'hono/route';

const route = (c: Context) => matchedRoutes(c).find((r) => r.method !== 'ALL')?.path;

const server = new OpenAPIHono();
server.use(
  httpInstrumentationMiddleware({
    getRoute: route,
    spanNameFactory: (c) => `${c.req.method} ${route(c) ?? routePath(c)}`,
  }),
);
server.route('/', mountRouter(apiContext, [thingsRouter]));
```

`getRoute` sets the `http.route` attribute. `spanNameFactory` sets the name of the span. On a 404, no route matches, so the span name uses `routePath(c)`.

`find` picks the outermost method-specific match. It is a heuristic. With overlapping routes such as `/items/me` and `/items/:id`, it reports the route that Hono registered first.

## Scaling

Type-checking time increases linearly with the number of routes. Most of this time is in `@hono/zod-openapi` and zod. The library adds about 2% to the type work of the same routes without the library.

The measured fixture is the fixture of `pnpm check:type-budget`, in `tools/type-budget.ts`. It has 50 routers with 2 routes each, mounted with `mountRouter`. Each router has its own `Variables` type. One route is a `GET` with path params. The other route is a `PUT` with path params and a JSON body. Both routes use `handle` with one `onError` arm. The versions are `@hono/zod-openapi` 1.6.3, hono 4.13.12, and zod 4.6.5.

On this fixture, each route costs about 2,300 type instantiations. Each route adds about 3 ms of type-checking time on TypeScript 5.9.3, and about 1 ms on TypeScript 7.0.2. These times come from an Apple M3 Max laptop. Your times depend on your machine and on your routes. `tools/type-budget.json` has the current count.

You can give each router its own `Variables` type with `.middleware<Vars>()`. Each unique `Variables` type adds about 400 type instantiations, so this cost is small. You do not need to share one `Variables` type for performance. You do not need to augment `ContextVariableMap` for performance.

Use `@hono/zod-openapi` 1.6.2 or later. Versions before 1.6.1 do about 60,000 type instantiations for each router with a unique `Variables` type. Version 1.6.1 does about 8,000. Version 1.6.2 removed this cost. With the earlier versions, a project with many routers can exceed the default 4 GB heap of TypeScript 5.9.

To make type-checking faster:

- Use TypeScript 7.
- Keep `@hono/zod-openapi` up to date.

## Migrating from 0.x

The 0.x names still work in 1.x. The library marks them `@deprecated`, and version 2.0 will remove them.

| 0.x                                                                           | 1.x                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `makeHonoResponse(schema, desc)`                                              | `jsonResponse(schema, desc)`                                                                            |
| `makeHonoJsonBody(schema, desc)`                                              | `jsonBody(schema, desc)`                                                                                |
| `makeHonoJsonRequest(schema, desc)`                                           | `jsonRequest(schema, desc)`                                                                             |
| `makeHonoNoContentResponse(desc)`                                             | `emptyResponse(desc)`                                                                                   |
| `createRouter({ base })`                                                      | `createRouter({ routeDefaults })`                                                                       |
| `route(method, config)`                                                       | `defineRoute(method, config)`                                                                           |
| `({ router, route })` in the callback of `makeRouter`                         | `({ app, defineRoute })`                                                                                |
| `handler(c, fn).errors(arms)`                                                 | `handle(c, fn, arms)`                                                                                   |
| `handler(c, fn)`                                                              | `handle(c, fn)`                                                                                         |
| `on(ErrorClass, fn)`                                                          | `onError(ErrorClass, fn)`                                                                               |
| `RETHROW`                                                                     | `rethrow()`                                                                                             |
| `defineRootRoute`                                                             | `defineRootContext`                                                                                     |
| `defineChildRoute`                                                            | `defineChildContext`                                                                                    |
| `defineChildRoute<typeof p>()(s)`                                             | `defineChildContext(p, s)`, or `defineChildContext<typeof p>()(s)` (the curried form is not deprecated) |
| `createScopeMiddleware({ resolve: (c) => c.var.session.scopes })`             | `createScopeMiddleware<SessionVars>({ resolve })`, or `createScopeMiddleware(context, { resolve })`     |
| `Context<{ Variables: V }>` with a `{ Bindings: B; Variables: V }` middleware | `Context<{ Bindings: B; Variables: V }>`                                                                |

The old names are aliases. They hold the same functions, so this code still compiles. Your editor marks each old name as deprecated:

```ts
import { defineChildRoute, defineRootRoute } from 'hono-typed-router';

const apiContext = defineRootRoute('/api');
const thingsContext = defineChildRoute(apiContext, '/things');
```

`extendRouteContext` also returns the old names as deprecated keys.

The last two rows of the table are breaking changes, not aliases. In 1.x, `createScopeMiddleware` types `c.var` in `resolve`. Without a type argument or a context, `c.var` has no vars, so the 0.x form is a compile error.

In 1.x, a middleware typed `{ Bindings: B; Variables: V }` in the root array or in `.middleware()` gives the bindings `B` to the context. In 0.x, the context dropped them. The `Env` of the app is then `{ Bindings: B; Variables: V }`. Hono's `Context<E>` accepts only an `Env` with the same `Bindings` and `Variables`, not a wider or narrower one. Thus a handler or a helper typed only `{ Variables: V }`, such as `RouteHandler<typeof r, { Variables: V }>` or `(c: Context<{ Variables: V }>) => ...`, is a compile error (TS2345). Type it `{ Bindings: B; Variables: V }`.

Two type changes have no alias:

- The type `HandlerFn` is removed. Use `typeof handle`.
- A `RouteMiddlewareFactory` takes `(route, meta)` and can return `undefined`. Code that calls a factory directly, for example in a unit test, must give a `meta` argument (`{ path }`).

[`CHANGELOG.md`](../CHANGELOG.md) is the canonical list of 1.0 changes. It includes the type-level breaking changes and their migration notes.
