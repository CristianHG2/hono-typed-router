# hono-typed-router

This library is a path-typed router builder for [Hono](https://hono.dev). It has composable middleware contexts and per-route policy hooks. It is built on top of [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi).

- **Typed paths**: route paths go through the type system. A child route inherits the path of its parent _and_ the context variables that the parent accumulated.
- **Composable contexts**: you attach middleware with `.middleware<Vars>(...)`. The new variables are then available to every route under that context. Type-level guards prevent a redeclaration.
- **Per-route policy hook**: you register a `routeMiddleware` factory one time on the router. It runs against every declared route, with full access to the resolved `RouteConfig` and the path of the route. It is a drop-in location for scope checks, audit logging, rate limits, and anything else that is cross-cutting.
- **OpenAPI built-in**: you declare every route with `createRoute`. As a result, the app has full OpenAPI metadata.

## Install

```sh
npm i hono-typed-router hono @hono/zod-openapi zod
```

Peer dependencies: `hono ^4.12`, `@hono/zod-openapi ^1.1`, `zod ^4`.

**TypeScript 7:** if your `tsconfig.json` sets an explicit `lib`, also set
`"types": ["node"]`, or add a DOM lib. TypeScript 7 no longer loads `@types/*`
automatically. Without these types, the `Response` type of hono resolves to `any`.
Then wrong response statuses or bodies are not compile errors. No error tells you that this occurred.

## Quick start

```ts
import { z } from 'zod';
import { createRouter, defineRootRoute, defineChildRoute, jsonResponse } from 'hono-typed-router';

const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

// 1. Define the root context — base path + global middlewares.
const rootRoute = defineRootRoute('/api', []);

// 2. Build a router factory. Hooks attached here apply to every router built from it.
const makeRouter = createRouter();

// 3. Declare a child context. Its path is '/api/things', in the type and at runtime.
const thingsRoute = defineChildRoute(rootRoute, '/things');

// 4. Build the router. `defineRoute()` declares + returns a RouteConfig; `router.openapi()`
//    registers the handler. Return the chain of `.openapi()` calls.
const thingsRouter = makeRouter(thingsRoute, ({ router, defineRoute }) => {
  const list = defineRoute('get', { responses: { 200: okResponse } });
  return router.openapi(list, (c) => c.json({ ok: true }, 200));
});

// 5. Mount children under the root and expose the final Hono app.
const app = makeRouter(rootRoute, ({ router }) => router, [thingsRouter])();
// GET /api/things -> { ok: true }
```

Return `router.openapi(a, ha).openapi(b, hb)` from the factory. Do not return `router` after
separate `router.openapi(...)` calls. Each `.openapi()` call returns the router with
that route added to its type. Hono's RPC client (`hc`, `testClient`) reads the routes
from that type. The runtime is the same for the two forms.

## Complete example

This example makes a small API for things. It shows one router with child routers, a file-based layout, and the middleware options. The two versions declare the same three routes:

- `GET /api/things` returns the things of the current user.
- `POST /api/things` makes a thing. This route requires the `things:write` scope.
- `GET /api/things/:id` returns one thing. If the thing does not exist, it returns 404.

### One router with child routers

This version declares the root, child, and grandchild contexts in one file. In one file, you can use the value form `defineChildRoute(parent, path)`. The `./services` module is your own code.

```ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  createRouter,
  defineChildRoute,
  defineRootRoute,
  handle,
  jsonRequest,
  jsonResponse,
  matchErrors,
} from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';
// Your own code. `ThingNotFound` declares `readonly _tag = 'ThingNotFound' as const`.
import { createThing, findThing, listThings, ThingNotFound, verifySession } from './services';

const Thing = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
const CreateThing = z.object({ name: z.string().min(1) });
const ErrorBody = z.object({ error: z.string() });

// 1. Root context. Its middleware sets a typed `session` variable.
const rootRoute = defineRootRoute('/api', []).middleware<{
  session: { userId: string; scopes: string[] };
}>(async function authenticate(c, next) {
  const session = await verifySession(c.req.header('authorization'));
  if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
  c.set('session', session);
  await next();
});

// 2. One router factory. Its options apply to every route that it declares.
const makeRouter = createRouter({
  routeDefaults: { responses: { 401: jsonResponse(ErrorBody, 'Unauthorized') } },
  routeMiddleware: [
    createScopeMiddleware({ resolve: (c) => c.var.session.scopes }),
    (route, meta) =>
      async function logRequest(c, next) {
        await next();
        console.info(`${route.method} ${meta.path} -> ${c.res.status}`);
      },
  ],
  transformRoute: (config, meta) => ({
    ...config,
    // GET /api/things/:id -> 'get_api_things_id'
    operationId:
      config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
  }),
});

// 3. Child and grandchild contexts: '/api/things' and '/api/things/:id'.
const thingsRoute = defineChildRoute(rootRoute, '/things');
const thingByIdRoute = defineChildRoute(thingsRoute, '/:id');

const thingByIdRouter = makeRouter(thingByIdRoute, ({ router, defineRoute }) => {
  const read = defineRoute('get', {
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: jsonResponse(Thing, 'The thing'),
      404: jsonResponse(ErrorBody, 'Not found'),
    },
  });

  return router.openapi(read, (c) =>
    handle(
      c,
      async ({ param: { id } }) => c.json(await findThing(id), 200),
      matchErrors([ThingNotFound], {
        ThingNotFound: (_e, ec) => ec.json({ error: 'NOT_FOUND' }, 404),
      }),
    ),
  );
});

const thingsRouter = makeRouter(
  thingsRoute,
  ({ router, defineRoute }) => {
    const list = defineRoute('get', {
      responses: { 200: jsonResponse(z.array(Thing), 'The things of the user') },
    });
    const create = defineRoute('post', {
      request: jsonRequest(CreateThing, 'The new thing'),
      responses: { 201: jsonResponse(Thing, 'The created thing') },
      security: [{ bearer: ['things:write'] }],
    });

    return router
      .openapi(list, async (c) => c.json(await listThings(c.var.session.userId), 200))
      .openapi(create, async (c) =>
        c.json(await createThing(c.var.session.userId, c.req.valid('json')), 201),
      );
  },
  [thingByIdRouter],
);

// 4. Mount the child under the root. The result is an `OpenAPIHono` app.
const app = makeRouter(rootRoute, ({ router }) => router, [thingsRouter])();

// 5. Serve the OpenAPI document from an outer app, outside `authenticate`.
export const server = new OpenAPIHono().route('/', app);
server.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Things API', version: '1.0.0' } });
```

Mount each child router under the router of its parent context. The router of `thingByIdRoute` serves its routes at its own segment, `/:id`. Under the root, its routes go to `/api/:id` and not to `/api/things/:id`.

The `authenticate` middleware runs on every path under `/api`. For this reason, the example serves the OpenAPI document from an outer app. This outer app gets the routes and the OpenAPI data of `app`.

The app gives these results:

| Request                                   | Result                                                       |
| ----------------------------------------- | ------------------------------------------------------------ |
| `GET /api/things` with a valid token      | 200 with the things of the session user                      |
| `GET /api/things` without a token         | 401 from `authenticate`                                      |
| `POST /api/things` without `things:write` | 403 from `createScopeMiddleware`                             |
| `POST /api/things` with an empty `name`   | 400 from the body validation                                 |
| `GET /api/things/:id` for an unknown `id` | 404 from `matchErrors`                                       |
| `GET /openapi.json`                       | `get_api_things`, `post_api_things`, and `get_api_things_id` |

### File-based layout

The same API can use one file for each context. The directories follow the URL, as in [`docs/usage.md`](./docs/usage.md#recommended-project-layout).

```
src/
  services.ts        # your code: verifySession, listThings, createThing, findThing, ThingNotFound
  api/
    index.ts         # /api: root context, app, and OpenAPI document
    router.ts        # the shared makeRouter and schemas
    things/
      index.ts       # /api/things
      [id].ts        # /api/things/:id
```

A parent module imports the router of its child, and the child module imports the context of its parent. The curried form `defineChildRoute<typeof parent>()(path)` needs only the type of the parent, so an `import type` prevents a runtime cycle.

When the parent mounts a curried child, `meta.path` is the full path. If you call the thunk of a curried child directly, `meta.path` starts at the segment of the child. For example, a test that calls `thingByIdRouter()` sees `/:id`. For this reason, each route in this layout sets its own `operationId`. The `transformRoute` hook keeps an `operationId` that a route sets.

**`src/api/router.ts`** has the shared policy. Each router module imports `makeRouter` from it.

```ts
import { createRouter, jsonResponse } from 'hono-typed-router';
import { createScopeMiddleware } from 'hono-typed-router/scopes';
import { z } from 'zod';

export const Thing = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
export const ErrorBody = z.object({ error: z.string() });

export const makeRouter = createRouter({
  routeDefaults: { responses: { 401: jsonResponse(ErrorBody, 'Unauthorized') } },
  routeMiddleware: createScopeMiddleware({ resolve: (c) => c.var.session.scopes }),
  transformRoute: (config, meta) => ({
    ...config,
    operationId:
      config.operationId ?? `${config.method}_${meta.path}`.replaceAll(/[^A-Za-z0-9]+/g, '_'),
  }),
});
```

**`src/api/index.ts`** declares the root context. It also builds the app and serves the OpenAPI document.

```ts
import { OpenAPIHono } from '@hono/zod-openapi';
import { defineRootRoute } from 'hono-typed-router';
import { verifySession } from '../services';
import { makeRouter } from './router';
import { thingsRouter } from './things';

export const rootRoute = defineRootRoute('/api', []).middleware<{
  session: { userId: string; scopes: string[] };
}>(async function authenticate(c, next) {
  const session = await verifySession(c.req.header('authorization'));
  if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
  c.set('session', session);
  await next();
});

const app = makeRouter(rootRoute, ({ router }) => router, [thingsRouter])();

export const server = new OpenAPIHono().route('/', app);
server.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Things API', version: '1.0.0' } });
```

**`src/api/things/index.ts`** declares the child context. It mounts the router of the grandchild.

```ts
import { defineChildRoute, jsonRequest, jsonResponse } from 'hono-typed-router';
import { z } from 'zod';
import type { rootRoute } from '..'; // type-only: no runtime cycle
import { createThing, listThings } from '../../services';
import { makeRouter, Thing } from '../router';
import { thingByIdRouter } from './[id]';

export const thingsRoute = defineChildRoute<typeof rootRoute>()('/things');

export const thingsRouter = makeRouter(
  thingsRoute,
  ({ router, defineRoute }) => {
    const list = defineRoute('get', {
      operationId: 'listThings',
      responses: { 200: jsonResponse(z.array(Thing), 'The things of the user') },
    });
    const create = defineRoute('post', {
      operationId: 'createThing',
      request: jsonRequest(z.object({ name: z.string().min(1) }), 'The new thing'),
      responses: { 201: jsonResponse(Thing, 'The created thing') },
      security: [{ bearer: ['things:write'] }],
    });

    return router
      .openapi(list, async (c) => c.json(await listThings(c.var.session.userId), 200))
      .openapi(create, async (c) =>
        c.json(await createThing(c.var.session.userId, c.req.valid('json')), 201),
      );
  },
  [thingByIdRouter],
);
```

**`src/api/things/[id].ts`** declares the grandchild context.

```ts
import { defineChildRoute, handle, jsonResponse, matchErrors } from 'hono-typed-router';
import { z } from 'zod';
import type { thingsRoute } from '.'; // type-only: no runtime cycle
import { findThing, ThingNotFound } from '../../services';
import { ErrorBody, makeRouter, Thing } from '../router';

export const thingByIdRoute = defineChildRoute<typeof thingsRoute>()('/:id');

export const thingByIdRouter = makeRouter(thingByIdRoute, ({ router, defineRoute }) => {
  const read = defineRoute('get', {
    operationId: 'getThing',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: jsonResponse(Thing, 'The thing'),
      404: jsonResponse(ErrorBody, 'Not found'),
    },
  });

  return router.openapi(read, (c) =>
    handle(
      c,
      async ({ param: { id } }) => c.json(await findThing(id), 200),
      matchErrors([ThingNotFound], {
        ThingNotFound: (_e, ec) => ec.json({ error: 'NOT_FOUND' }, 404),
      }),
    ),
  );
});
```

In each file, `c.var.session` is typed. The type comes from `typeof rootRoute` through the curried contexts.

### Which middleware to use

- If a middleware sets variables for all routes under a context, use `.middleware<Vars>(handler)` on that context.
- If a policy depends on the config of each route, use a `routeMiddleware` factory.
- If routes declare scopes in `security`, set `createScopeMiddleware` as the `routeMiddleware`. It returns 403 if a required scope is missing.
- If you must change the OpenAPI data of each route, use `transformRoute`. It does not change the static types.

Give each `routeMiddleware` a function name, for example `logRequest`. Then `showRoutes(app, { verbose: true })` from `hono/dev` shows this name.

## Concepts

### `defineRootRoute(path, middlewares)`

This function makes the root `RouteContext`. The `path` becomes the base path of each router that you build from this context. The `middlewares` array runs on every request that reaches routers under this context.

Write context paths with Hono `:param` syntax, here and in `defineChildRoute`. If a context path uses `{param}`, the router mounts the path literally, and the path returns 404. But `meta.path` reports it as `:param`.

### `defineChildRoute(parent, path)`

This function makes a child `RouteContext`. The path of the child is `parent.path` joined with `path` by `/`, in the type and at runtime. For example, `'/api'` + `'/things'` and `'/api'` + `'things'` both give `/api/things`. A root `'/'` adds no second slash. The child inherits its variables from the parent.

You mount children on the parent in `makeRouter(parent, factory, [child])`. The child does not copy the middlewares of the parent. The router of the parent runs them, because you mount the child under that router. You can mount a value-form child under the parent context, or under a context that you made from that parent with `.middleware()`. If you mount it under a different context, `makeRouter` throws an error.

**Curried form for circular imports.** `defineChildRoute<typeof parent>()(path)` takes the parent as a type only. Use this form when two modules import each other:

- The module of the parent imports the router of the child to mount it.
- The module of the child imports the context of the parent.

With a type-only import, there is no runtime cycle. The value form needs the parent value when the child module loads. A circular import does not supply this value. In the curried form, the runtime `path` of the child is only its own segment (the type is still the full path). When the parent mounts the router of the child, `meta.path` is still the full path.

```ts
import type { rootRoute } from '..'; // type-only: no runtime cycle

export const thingsRoute = defineChildRoute<typeof rootRoute>()('/things');
```

### `.middleware<NewVars>(handler)`

This method adds a middleware to the context. The middleware can set new variables on `c.var`. These variables are then available to the middleware and route handlers that come after it. A redeclaration of an existing variable is a type error.

```ts
type SessionVar = { session: { userId: string } };

const authed = defineRootRoute('/api', []).middleware<SessionVar>(async (c, next) => {
  c.set('session', await loadSession(c));
  await next();
});

const meRoute = defineChildRoute(authed, '/me');
//  routes built from meRoute see `c.var.session` typed.
```

**Reusable middleware.** Build a middleware one time with `createMiddleware` from `hono/factory`. Then give it to more than one context:

```ts
import { createMiddleware } from 'hono/factory';

type Session = { userId: string; scopes: string[] };

const requireSession = createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
  const session = await findSession(c.req.header('authorization'));

  if (!session) return c.json({ error: 'UNAUTHORIZED' }, 401);
  c.set('session', session);
  await next();
});

const apiRoute = defineRootRoute('/api', []).middleware<{ session: Session }>(requireSession);
const adminRoute = defineRootRoute('/admin', []).middleware<{ session: Session }>(requireSession);
```

The `Variables` of the middleware must be equal to the vars of the context plus the new vars. The `Context` type of Hono does not accept other vars. If the context already has vars, build the type with `ContextEnv<typeof context, NewVars>`. The middleware can then also read the vars of the context:

```ts
import type { ContextEnv } from 'hono-typed-router';

const loadTenant = createMiddleware<ContextEnv<typeof apiRoute, { tenantId: string }>>(
  async (c, next) => {
    c.set('tenantId', `tenant-of-${c.var.session.userId}`);
    await next();
  },
);

const tenantRoute = apiRoute.middleware<{ tenantId: string }>(loadTenant);
```

A middleware built with `ContextEnv` fits only contexts that have the same vars, for example `apiRoute` and its children.

### `createRouter({ routeMiddleware?, routeDefaults?, transformRoute? })`

This function returns a `makeRouter`. The optional `routeMiddleware` is a factory, or an array of factories, of the form `(route: RouteConfig, meta: RouteHookMeta) => MiddlewareHandler`. Each factory runs **one time, at route declaration**, with the resolved `RouteConfig`. The router attaches the returned middleware to the exact method and path of the route.

```ts
const makeRouter = createRouter({
  routeMiddleware: [
    (route, meta) => async (c, next) => {
      console.log('hit', route.method, meta.path); // e.g. "get /api/things/:id"
      await next();
    },
  ],
});
```

`meta.path` is the full mount path of the router joined with the path of the route, in Hono `:param` syntax. `route.path` itself is relative to the router, usually `'/'`. At request time, `routePath(c)` from `hono/route` also gives the full matched path.

When a parent mounts a router as a child, the parent gives its own full path to the child. For this reason, `meta.path` of a mounted router is always the full URL path. A thunk that you call directly, without a parent, uses the path of its context. For a root, this path is the full path. For a value-form child, it is the full path only if each ancestor is a root or a value-form child. If an ancestor is curried, the path starts at the segment of that ancestor. For a curried child, it is only the segment.

Use the array form to compose multiple concerns (scope check, request log, audit). Each middleware can call `next()` to continue. It can also return a `Response` to stop the chain and send that response. This behavior is the same as in a regular Hono middleware.

#### `routeDefaults` — shared RouteConfig fragment

This option is a partial `RouteConfig`. The router deep-merges it into every route that it declares. These are the merge rules:

- Per-route values win on key conflicts.
- The merge concatenates arrays, for example `security` and `tags`, and removes structural duplicates.
- **The merge makes a union of two zod schemas at the same position** (`defaultSchema.or(routeSchema)`). As a result, a per-route `422` schema combines with the default `422` schema and does not replace it.

The static type that `defineRoute()` returns shows the merged shape. As a result, handlers see the combined `responses`/`request` schema, with `ZodUnion<[default, route]>` at colliding schema slots.

- A route with `security: []` opts out of `routeDefaults.security`. The merged `security` is then `[]`, so `createScopeMiddleware` does not check scopes and the OpenAPI operation is public. Other empty arrays (for example `tags: []`) are still additive.

```ts
const unauthorized = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');

const makeRouter = createRouter({
  routeDefaults: { responses: { 401: unauthorized } },
});

makeRouter(rootRoute, ({ router, defineRoute }) => {
  const list = defineRoute('get', { responses: { 200: okResponse } });
  // `list.responses` is typed with both `200` and `401`.
  return router.openapi(list, (c) => c.json({ ok: true }, 200));
});
```

`base` is the deprecated name of this option. If you set both, the router uses `routeDefaults`.

#### `transformRoute` — runtime-only config transformer

This option is a hook of the form `(config: RouteConfig, meta: RouteHookMeta) => RouteConfig`. It runs immediately after the router makes the resolved `RouteConfig`, and after any `routeDefaults` merge. It runs _before_ the `routeMiddleware` factories see the config. The static type of the returned config does not change. This hook is only a runtime escape hatch for cross-cutting changes, for example auto-tagging, metadata injection, and normalization of security entries.

```ts
const makeRouter = createRouter({
  transformRoute: (route) => ({
    ...route,
    tags: [...(route.tags ?? []), route.method === 'get' ? 'read' : 'write'],
  }),
});
```

As with `routeMiddleware`, `config.path` here is relative, usually `'/'`. If you need the path of the route, use `meta.path`. For example, use it to derive an `operationId` (see `docs/usage.md`). The router computes `meta.path` before the hook runs. `meta.path` does not change if the hook rewrites `config.path`.

### `defineRoute(method, config)`

Inside a router factory, `defineRoute()` builds and returns a `createRoute()` config. The path of this config is locked to the path of the context. The returned config goes directly into `router.openapi(config, handler)`.

### Using multiple middlewares

You can add middlewares in three places. For one request, they run in this order:

1. The array of `defineRootRoute(path, [a, b])`. These middlewares run for every request under the context, in array order.
2. The `.middleware<A>(a).middleware<B>(b)` chain, in chain order. Each call adds typed vars. The middlewares and handlers after it can read these vars.
3. The `routeMiddleware: [x, y]` factories of `createRouter`, in array order. Their middlewares run only for the declared route.

Then the validators of the route run, and then the handler. This example uses the three places:

```ts
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { createRouter, defineRootRoute, jsonResponse } from 'hono-typed-router';

const calls: string[] = [];

const timing = createMiddleware(async (c, next) => {
  calls.push('timing');
  const start = Date.now();
  await next();
  c.header('Server-Timing', `total;dur=${Date.now() - start}`);
});

const noStore = createMiddleware(async (c, next) => {
  calls.push('noStore');
  await next();
  c.header('Cache-Control', 'no-store');
});

const rootRoute = defineRootRoute('/api', [timing, noStore])
  .middleware<{ requestId: string }>(async (c, next) => {
    calls.push('requestId');
    c.set('requestId', c.req.header('x-request-id') ?? 'none');
    await next();
  })
  .middleware<{ log: (message: string) => void }>(async (c, next) => {
    calls.push('log');
    c.set('log', (message) => console.info(`[${c.var.requestId}] ${message}`));
    await next();
  });

const makeRouter = createRouter({
  routeMiddleware: [
    (route) =>
      async function audit(_c, next) {
        calls.push(`audit:${route.method}`);
        await next();
      },
    () =>
      async function rateLimit(_c, next) {
        calls.push('rateLimit');
        await next();
      },
  ],
});

const app = makeRouter(rootRoute, ({ router, defineRoute }) => {
  const search = defineRoute('get', {
    request: { query: z.object({ q: z.string() }) },
    responses: { 200: jsonResponse(z.object({ q: z.string() }), 'OK') },
  });

  return router.openapi(search, (c) => {
    calls.push('handler');
    const { q } = c.req.valid('query');
    c.var.log(`search ${q}`);

    return c.json({ q }, 200);
  });
})();

await app.request('/api?q=hono');
// calls: ['timing', 'noStore', 'requestId', 'log', 'audit:get', 'rateLimit', 'handler']
```

If a request has no `q`, the validator returns 400 after the six middlewares, and the handler does not run.

Use each place for a different job:

- If a middleware sets no vars, for example for timing, CORS, or headers, put it in the `defineRootRoute` array.
- If a middleware sets vars that later code reads, add it with `.middleware<Vars>()`.
- If a middleware needs the config of the route, for example its `security` scopes, use a `routeMiddleware` factory.

A `routeMiddleware` factory returns an untyped `MiddlewareHandler`, so a factory that returns `createMiddleware<{ Variables: { session: Session } }>(...)` type-checks also when no middleware sets `session`.

## Scope-check helper

A frequent use of `routeMiddleware` is to enforce OAuth-style scopes that a route declares in its `security`. Use the sub-entry helper:

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

- The middleware extracts the required scopes from every entry in `route.security`. It flattens them across schemes and removes duplicates.
- If `route.security` is absent or empty, the middleware does nothing.
- If one or more required scopes are missing from `resolve(c)`, the middleware returns **403** with the configured body.

## Helpers

These helpers mirror the shape that `@hono/zod-openapi` expects:

```ts
import { createRoute } from '@hono/zod-openapi';
import { emptyResponse, jsonBody, jsonRequest, jsonResponse } from 'hono-typed-router';

const route = createRoute({
  method: 'post',
  path: '/things',
  request: jsonRequest(CreateBody, 'Create a thing'),
  responses: {
    200: jsonResponse(Thing, 'The created thing'),
    409: emptyResponse('A thing with that name already exists'),
  },
});
```

All four helpers take positional arguments: `(schema, description)`, or `(description)` for
`emptyResponse`. `jsonRequest` marks the body as **required** (`required: true`). As a result, the
validator gets `{}` for a request without a JSON body. If the schema has required
fields, the validation fails with a 400. In this case, the request does not reach the handler as `{}`.
`jsonBody` is the building block without `required`. For an optional body, use
`{ body: jsonBody(schema, description) }`.

## Type-safe error handling

`handle(c, fn, arms?)` runs the body of a route handler. It gives the body a destructurable
view over the validated inputs of the request. Optionally, it also takes a list of error arms.
`handle` reads each validation target (`param`, `query`, `json`, ...) from `c.req.valid`
lazily and caches it. As a result, it never reads untouched targets, and it reads each touched target one time.

TypeScript cannot infer what a function throws. As a result, you list the error classes that a
route maps, and `matchErrors` gives you one handler for each class:

```ts
import { handle, matchErrors, rethrow } from 'hono-typed-router';

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

- The handler keys come from the literal `_tag` of each class. If a class has no literal
  `_tag`, the key comes from its literal `name`. Declare it `override readonly name = 'X' as const`.
  A plain `this.name = 'X'` has the type `string` and does not count. The map is
  **exhaustive**. A missing key, an extra key, a class without a literal tag, or two
  classes with the same tag is a compile error. Each handler gets the instance of its own
  class (`e.sku`).
- If a thrown error is an instance of a listed class, `handle` uses the handler for the
  runtime `_tag` of the error. If the map has no handler for this `_tag`, `handle` uses the
  handler for the `name` of the error. The order of the list does not matter. A thrown value
  that is not an `Error` skips the arms.
- A subclass of a listed class with a `name` tag can declare a `_tag` that is equal to the tag
  of another listed class. Then the handler of that other class gets the error, and its
  parameter has the wrong type. Do not use one tag for two classes that are not related.
- To send the error to the next arm, return `rethrow()` from a handler. If there is no
  next arm, the dispatch throws the error again.
- `handle` **widens the result type with the response of each handler**. These responses
  go into the value that you return to `router.openapi(...)`. As a result, if a handler emits a
  status that the route did not declare in `responses`, this is a **compile error**. Then
  the OpenAPI contract and the runtime handler cannot become different. Without arms,
  `handle` returns exactly the promise of the body.

`matchErrors` returns a plain list of error arms. The primitive is
`onError(ErrorClass, (err, c) => response)`. It is one arm that matches errors that are
`instanceof ErrorClass`. Use it for a single arm, for a class without a literal tag,
or for arms that routes share. You can mix both forms in one list:

```ts
import { handle, matchErrors, onError } from 'hono-typed-router';

router.openapi(getThing, (c) =>
  handle(c, async ({ param: { id } }) => c.json(await findOrFail(id), 200), [
    ...matchErrors([CartNotFound], {
      CartNotFound: (_e, ec) => ec.json({ message: 'Not found' }, 404),
    }),
    onError(RecordNotFoundError, (_err, ec) => ec.json({ message: 'Not found' }, 404)),
  ]),
);
```

The arms run in order. An arm that returns `rethrow()` defers to the next arm.

The client types that `hc` and `testClient` see come from the `responses` of the route, not
from the handler. TypeScript type-checks `handle` and its arms against `responses`, so the two
agree.

`handleErrors(body, arms, c)` is the same dispatch without the input proxy. Use it when you
only need the error handling. Arms are reusable. Put common arms
(`recordNotFoundArm`, `uniqueViolationArm`, ...) into helpers that call `onError`.

## Testing

`testClient` from `hono/testing` calls the app in-process, with the same typed
client as `hc`. Build the app from the root thunk. The routes of the children are part of
its type.

```ts
import { testClient } from 'hono/testing';

const app = makeRouter(rootRoute, ({ router }) => router, [thingsRouter, thingRouter])();
const client = testClient(app);

const res = await client.api.things[':id'].$get({ param: { id: '42' } });

if (res.status === 200) {
  const thing = await res.json(); // typed from the route's 200 response
}
if (res.status === 404) {
  const error = await res.json(); // typed from the route's 404 response
}
```

Call the client on the root app. A child thunk alone, as in `testClient(thingRouter())`,
has full-path types. But it serves its routes at its own segment, without the middlewares
of the parent. Statuses that a `routeMiddleware` returns, such as the 403 from
`createScopeMiddleware`, are typed only if the route (or `routeDefaults`) declares them.

Pass `children` inline (or `as const`). A children array in a variable typed
`(() => OpenAPIHono)[]` keeps the runtime routes but drops them from the type. An
unannotated variable that mixes different thunks (`const kids = [things, thingById]`)
can also collapse to one element type. Then the type loses the routes of some children.

If two children declare the same method and path, the client type for that path is not correct.
It is `never`, or it merges the two bodies into one false type. The reason is that the app type intersects
the schemas of the children, as the `route()` method of Hono does. Declare each method and
path one time.

A factory can register its routes as statements and not return the chain. This factory keeps
the routes of its children in the app type, but loses its own routes. Return `router.openapi(...)`.
`app.request(path, init)` is the untyped fallback.

## Extending the `define[x]` context

`extendRouteContext` adds custom, type-safe builder methods to `defineRootRoute`
and `defineChildRoute`. With it, the "load `:id` once, expose it on `c.var`"
pattern becomes a first-class method. Each method keeps the path of the route and its
accumulated vars. The library applies the augmentation again automatically through
`.middleware()` and through the return values of the methods. As a result, a chain
never loses the builders.

Describe the extended context as a self-referential interface that extends
`RouteContextBase`. Pair it with a one-line `RouteContextKind`. Then pass the kind
as the type argument, and the runtime builders as the argument:

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
    key: TKey extends keyof TVars ? `Cannot redeclare existing var: "${TKey}"` : TKey,
    param: ParamKeys<TPath>,
    repository: () => TRepo,
  ) => ReaugmentContext<CtxKind, TPath, TVars & { [K in TKey]: RelationsFor<TRepo> }>;
}
interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

const { defineRootRoute, defineChildRoute } = extendRouteContext<CtxKind>({
  bindRepository: (ctx) => (key, param, repository) => {
    const mw: MiddlewareHandler = async (c, next) => {
      c.set(key, relationsFor(repository(), c.req.param(param)));
      await next();
    };
    return ctx.middleware(mw);
  },
});

// `orgRoute.vars.organization` is typed; `bindRepository` and `.middleware()`
// remain available for further chaining.
const orgRoute = defineChildRoute(rootRoute, '/organizations/:organizationId').bindRepository(
  'organization',
  'organizationId',
  () => organizationsRepository,
);
```

You can chain more than one builder, and `.middleware()` after them:

```ts
const teamRoute = defineChildRoute(rootRoute, '/organizations/:organizationId/teams/:teamId')
  .bindRepository('organization', 'organizationId', () => organizationsRepository)
  .bindRepository('team', 'teamId', () => teamsRepository)
  .middleware<{ membership: Membership }>(async (c, next) => {
    // `c.var.organization` and `c.var.team` are typed here.
    c.set('membership', await findMembership(c.var.organization, c.var.team));
    await next();
  });
```

Each builder augments the context again, so the next builders see all the vars that come before them.
A second bind with the same key is a compile error, and `param` must be a parameter of the path of the context.

The `key` guard rejects a redeclaration of an existing var. `param` must be one of
the path parameters of the route. TypeScript enforces both rules at the type level. The extended
`defineChildRoute` has the same value and curried forms as the base one.

## Recipes

### Binding a repository to a path parameter

For a one-off (without `extendRouteContext`), the pattern is a thin wrapper around
`.middleware`:

```ts
import type { RouteContext } from 'hono-typed-router';
import type { ParamKeys } from 'hono/types';

// Typed over concrete vars; for a reusable, generic builder use `extendRouteContext`.
const bindOrganization = <P extends string>(ctx: RouteContext<P, {}>, param: ParamKeys<P>) =>
  ctx.middleware<{ organization: Organization }>(async (c, next) => {
    const id = c.req.param(param);
    const organization = id ? await organizationsRepository.findById(id) : null;
    if (!organization) return c.json({ error: 'NOT_FOUND' }, 404);
    c.set('organization', organization);
    await next();
  });

const orgContext = defineChildRoute(rootRoute, '/organizations/:organizationId');
const orgRoute = bindOrganization(orgContext, 'organizationId');
```

### Multiple `routeMiddleware` hooks

```ts
import { routePath } from 'hono/route';

const makeRouter = createRouter({
  routeMiddleware: [
    createScopeMiddleware({ resolve: (c) => c.var.session.scopes }),
    (route) => async (c, next) => {
      const start = Date.now();
      await next();
      logger.info({ method: route.method, path: routePath(c), ms: Date.now() - start });
    },
  ],
});
```

## Observability

**Name your `routeMiddleware`.** Hono's `showRoutes(app, { verbose: true })` and
`inspectRoutes` (from `hono/dev`) show a middleware by its function name. Stack traces
also show it by this name. An inline arrow that a factory returns has no name.
Return a named function expression instead, or set the name with
`Object.defineProperty(fn, 'name', { value: '...' })`:

```ts
const makeRouter = createRouter({
  routeMiddleware: (route) =>
    async function auditLog(c, next) {
      await next();
    },
});
```

`createScopeMiddleware` already names its middleware, for example `requireScopes:things.read`.

`createMiddleware` from `hono/factory` returns the function that you give it. To name the middleware, give `createMiddleware` a named function, for example `createMiddleware(async function auditLog(c, next) { ... })`.

**Report the declared route to OpenTelemetry.** `@hono/otel` gets the span name from
the handler that ran when the app produced the response. If a context
middleware (registered on the whole subtree) returns a 401, the span reads
`GET /api/things/*` instead of `GET /api/things`. Instead, take the first matched route
that is not a subtree middleware. `getRoute` needs `@hono/otel` >= 1.2.0.
Register the instrumentation before you mount routes, because Hono runs
middleware in registration order:

```ts
import { httpInstrumentationMiddleware } from '@hono/otel';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { matchedRoutes, routePath } from 'hono/route';

const route = (c: Context) => matchedRoutes(c).find((r) => r.method !== 'ALL')?.path;

const app = new OpenAPIHono();
app.use(
  httpInstrumentationMiddleware({
    getRoute: route, // sets `http.route`
    // `@hono/otel` names the span separately; fall back to its default on a 404.
    spanNameFactory: (c) => `${c.req.method} ${route(c) ?? routePath(c)}`,
  }),
);
app.route('/', makeRouter(rootRoute, ({ router }) => router, [thingsRouter])());
```

`find` picks the outermost method-specific match. It is a heuristic. With
overlapping routes such as `/items/me` and `/items/:id`, it reports the route that Hono
registered first.

## Scaling

Type-checking cost increases linearly with the number of routes. It is about 27 ms for each route
on TypeScript 5.9, and about 4x less on TypeScript 7.

The expensive part is the number of routers with a **unique `Variables` type**
(the vars of the context of the router). The first time that TypeScript sees one, it does
about 60k type instantiations (about 8 MB of memory). Most of these instantiations are inside
the response typing of `@hono/zod-openapi`. Routers that share a context type share
that cost. With 2 routes for each router and a unique context for each router, TypeScript
5.9 can exceed its default 4 GB heap. This can occur somewhere between 400 and 600 routes.

Mitigations, in order of preference:

- Put more routes in each router: one router for each resource (collection and item
  routes together), not one for each endpoint.
- For per-resource vars, augment Hono's `ContextVariableMap`. Do not add them
  with `.middleware<Vars>()`. The routers then share one `Variables` type.
  The trade-off: every handler sees those vars as typed, even where no
  middleware sets them.
- Give the compiler more memory: `NODE_OPTIONS=--max-old-space-size=8192`.
- Use TypeScript 7. It is faster and uses less memory.

## Migrating from 0.x

The 0.x names still work in 1.x. The library marks them `@deprecated`, and version 2.0 will remove them.

| 0.x                                 | 1.x                                                           |
| ----------------------------------- | ------------------------------------------------------------- |
| `makeHonoResponse(schema, desc)`    | `jsonResponse(schema, desc)`                                  |
| `makeHonoJsonBody(schema, desc)`    | `jsonBody(schema, desc)`                                      |
| `makeHonoJsonRequest(schema, desc)` | `jsonRequest(schema, desc)`                                   |
| `makeHonoNoContentResponse(desc)`   | `emptyResponse(desc)`                                         |
| `createRouter({ base })`            | `createRouter({ routeDefaults })`                             |
| `route(method, config)`             | `defineRoute(method, config)`                                 |
| `handler(c, fn).errors(arms)`       | `handle(c, fn, arms)`                                         |
| `handler(c, fn)`                    | `handle(c, fn)`                                               |
| `on(ErrorClass, fn)`                | `onError(ErrorClass, fn)`                                     |
| `defineChildRoute<typeof p>()(s)`   | `defineChildRoute(p, s)` (the curried form is not deprecated) |

[`CHANGELOG.md`](./CHANGELOG.md) is the canonical list of 1.0 changes. It includes the type-level breaking changes and their migration notes.

## Documentation

- [`docs/usage.md`](./docs/usage.md): examples to copy and paste, for CRUD resources, nested children, serving, OpenAPI UI, opt-outs, and testing.
- [`docs/api.md`](./docs/api.md): the full signature reference.
- [`docs/design.md`](./docs/design.md): the rationale and the deliberate omissions.

## License

MIT
