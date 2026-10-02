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

// 4. Build the router. `route()` declares + returns a RouteConfig; `router.openapi()`
//    registers the handler. Return the chain of `.openapi()` calls.
const thingsRouter = makeRouter(thingsRoute, ({ router, route }) => {
  const list = route('get', { responses: { 200: okResponse } });
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

## Concepts

### `defineRootRoute(path, middlewares)`

This function makes the root `RouteContext`. The `path` becomes the base path of each router that you build from this context. The `middlewares` array runs on every request that reaches routers under this context.

Write context paths with Hono `:param` syntax, here and in `defineChildRoute`. If a context path uses `{param}`, the router mounts the path literally, and the path returns 404. But `meta.path` reports it as `:param`.

### `defineChildRoute(parent, path)`

This function makes a child `RouteContext`. The path of the child is `parent.path` joined with `path` by `/`, in the type and at runtime. For example, `'/api'` + `'/things'` and `'/api'` + `'things'` both give `/api/things`. A root `'/'` adds no second slash. The child inherits its variables from the parent.

You mount children on the parent in `makeRouter(parent, factory, [child])`. The child does not copy the middlewares of the parent. The router of the parent runs them, because you mount the child under that router.

**Curried form for circular imports.** `defineChildRoute<typeof parent>()(path)` takes the parent as a type only. Use this form when two modules import each other:

- The module of the parent imports the router of the child to mount it.
- The module of the child imports the context of the parent.

With a type-only import, there is no runtime cycle. The value form needs the parent value when the child module loads. A circular import does not supply this value. In the curried form, the runtime `path` of the child is only its own segment (the type is still the full path).

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

`meta.path` is the path of the context joined with the path of the route, in Hono `:param` syntax. For root contexts and value-form children, it is the full URL path. For a curried child, it starts at the child's own segment, because the runtime path of that child is only the segment. `route.path` itself is relative to the router, usually `'/'`. At request time, `routePath(c)` from `hono/route` also gives the full matched path.

Use the array form to compose multiple concerns (scope check, request log, audit). Each middleware can call `next()` to continue. It can also return a `Response` to stop the chain and send that response. This behavior is the same as in a regular Hono middleware.

#### `routeDefaults` — shared RouteConfig fragment

This option is a partial `RouteConfig`. The router deep-merges it into every route that it declares. These are the merge rules:

- Per-route values win on key conflicts.
- The merge concatenates arrays, for example `security` and `tags`, and removes structural duplicates.
- **The merge makes a union of two zod schemas at the same position** (`defaultSchema.or(routeSchema)`). As a result, a per-route `422` schema combines with the default `422` schema and does not replace it.

The static type that `route()` returns shows the merged shape. As a result, handlers see the combined `responses`/`request` schema, with `ZodUnion<[default, route]>` at colliding schema slots.

- A route with `security: []` opts out of `routeDefaults.security`. The merged `security` is then `[]`, so `createScopeMiddleware` does not check scopes and the OpenAPI operation is public. Other empty arrays (for example `tags: []`) are still additive.

```ts
const unauthorized = jsonResponse(z.object({ error: z.string() }), 'Unauthorized');

const makeRouter = createRouter({
  routeDefaults: { responses: { 401: unauthorized } },
});

makeRouter(rootRoute, ({ router, route }) => {
  const list = route('get', { responses: { 200: okResponse } });
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

### `route(method, config)`

Inside a router factory, `route()` builds and returns a `createRoute()` config. The path of this config is locked to the path of the context. The returned config goes directly into `router.openapi(config, handler)`.

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
- `handle` matches a thrown error against the classes in list order, with `instanceof`.
  As a result, list a subclass before its parent. A thrown value that is not an `Error` skips the arms.
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
// `NoInfer` keeps `P` inferred from the context's path rather than from the param name.
const bindOrganization = <P extends string>(
  ctx: RouteContext<P, {}>,
  param: NoInfer<ParamKeys<P>>,
) =>
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

`orgContext` is a variable on purpose. If you nest `defineChildRoute(rootRoute, …)` inline in the `bindOrganization(…)` call, `P` infers as `string`. Then `ParamKeys<P>` is `never`, and TypeScript rejects the param name. The curried form works inline.

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
