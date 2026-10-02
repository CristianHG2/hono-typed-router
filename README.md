# hono-typed-router

Path-typed router builder for [Hono](https://hono.dev) with composable middleware contexts and per-route policy hooks. Built on top of [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi).

- **Typed paths** — route paths flow through the type system; child routes inherit the parent's path _and_ its accumulated context variables.
- **Composable contexts** — attach middleware via `.middleware<Vars>(...)` and the new variables become available to every route under that context, with type-level guards against redeclaration.
- **Per-route policy hook** — register a `routeMiddleware` factory once on the router; it runs against every declared route with full access to the resolved `RouteConfig` and the route's path. Drop-in spot for scope checks, audit logging, rate limits, anything cross-cutting.
- **OpenAPI built-in** — every route is declared via `createRoute`; the resulting app has full OpenAPI metadata.

## Install

```sh
npm i hono-typed-router hono @hono/zod-openapi zod
```

Peer deps: `hono ^4.12`, `@hono/zod-openapi ^1.1`, `zod ^4`.

**TypeScript 7:** if your `tsconfig.json` sets an explicit `lib`, also set
`"types": ["node"]` (or add a DOM lib). TypeScript 7 no longer loads `@types/*`
automatically. Without them, hono's `Response` type resolves to `any`, and
wrong response statuses or bodies stop being compile errors. No error tells you this happened.

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

Return `router.openapi(a, ha).openapi(b, hb)` from the factory, not `router` after
separate `router.openapi(...)` calls. Each `.openapi()` call returns the router with
that route added to its type, and Hono's RPC client (`hc`, `testClient`) reads the routes
from that type. The runtime is the same either way.

## Concepts

### `defineRootRoute(path, middlewares)`

Creates the root `RouteContext`. The `path` becomes the base path of any router built from this context, and the `middlewares` array runs on every request that hits routers under it. Write context paths (here and in `defineChildRoute`) with Hono `:param` syntax: a `{param}` context path is mounted literally and returns 404, while `meta.path` reports it as `:param`.

### `defineChildRoute(parent, path)`

Creates a child `RouteContext`. The child's path is `parent.path` joined with `path` by `/` (`'/api'` + `'/things'` and `'/api'` + `'things'` both give `/api/things`; a root `'/'` adds no second slash), both in the type and at runtime, and its variables are inherited from the parent. Children are mounted on the parent in `makeRouter(parent, factory, [child])`. The child does not copy the parent's middlewares: mounting under the parent's router runs them.

**Curried form for circular imports.** `defineChildRoute<typeof parent>()(path)` takes the parent as a type only. Use it when the parent's module imports the child's router to mount it, and the child's module imports the parent's context: with a type-only import there is no runtime cycle. The value form needs the parent value when the child module loads, which a circular import does not provide. In the curried form the child's runtime `path` is only its own segment (the type is still the full path).

```ts
import type { rootRoute } from '..'; // type-only: no runtime cycle

export const thingsRoute = defineChildRoute<typeof rootRoute>()('/things');
```

### `.middleware<NewVars>(handler)`

Adds a middleware to the context and surfaces any new variables it sets on `c.var` to subsequent middleware and route handlers. Redeclaring an existing variable is a type error.

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

Returns a `makeRouter`. Optional `routeMiddleware` is a factory (or array of factories) of the form `(route: RouteConfig, meta: RouteHookMeta) => MiddlewareHandler`. Each factory is invoked **once at route declaration** with the resolved `RouteConfig`; the returned middleware is attached to the route's exact method + path.

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

`meta.path` is the context's path joined with the route's path, in Hono `:param` syntax. It is the full URL path for root contexts and value-form children. For a curried child it starts at the child's own segment, because that child's runtime path is only the segment. `route.path` itself is relative to the router (usually `'/'`). At request time, `routePath(c)` from `hono/route` also gives the full matched path.

Use array form to compose multiple concerns (scope check + request log + audit). Each middleware can call `next()` to continue or return a `Response` to short-circuit, exactly like a regular Hono middleware.

#### `routeDefaults` — shared RouteConfig fragment

A partial `RouteConfig` deep-merged into every route declared by this router. Per-route values win on key conflicts; arrays (e.g. `security`, `tags`) are concatenated and structurally deduplicated; **two zod schemas at the same position are unioned** (`defaultSchema.or(routeSchema)`) so a per-route `422` schema is combined with the default `422` schema rather than replacing it. The merged shape is reflected in the static type returned by `route()`, so handlers see the combined `responses`/`request` schema (with `ZodUnion<[default, route]>` at colliding schema slots).

- A route with `security: []` opts out of `routeDefaults.security`: the merged `security` is `[]`, so `createScopeMiddleware` does not check scopes and the OpenAPI operation is public. Other empty arrays (for example `tags: []`) are still additive.

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

`base` is the deprecated name of this option. If you set both, `routeDefaults` is used.

#### `transformRoute` — runtime-only config transformer

A hook of the form `(config: RouteConfig, meta: RouteHookMeta) => RouteConfig`. It runs immediately after the resolved `RouteConfig` is produced (and after any `routeDefaults` merge), and _before_ `routeMiddleware` factories see it. The static type of the returned config is unchanged — this is purely a runtime escape hatch for cross-cutting mutations (auto-tagging, injecting metadata, normalizing security entries, etc.).

```ts
const makeRouter = createRouter({
  transformRoute: (route) => ({
    ...route,
    tags: [...(route.tags ?? []), route.method === 'get' ? 'read' : 'write'],
  }),
});
```

As with `routeMiddleware`, `config.path` here is relative (usually `'/'`). Use `meta.path` when you need the route's path, for example to derive an `operationId` (see `docs/usage.md`). `meta.path` is computed before the hook runs and does not change if the hook rewrites `config.path`.

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

All four take positional arguments: `(schema, description)`, or `(description)` for
`emptyResponse`. `jsonRequest` marks the body as **required** (`required: true`), so a
request without a JSON body is validated as `{}`: if the schema has required
fields it fails with a 400 instead of reaching the handler as `{}`. `jsonBody` is the building block without `required`; use
`{ body: jsonBody(schema, description) }` for an optional body.

## Type-safe error handling

`handle(c, fn, arms?)` runs a route handler body with a destructurable view over the
request's validated inputs and, optionally, a list of error arms. Each validation
target (`param`, `query`, `json`, ...) is read from `c.req.valid` lazily and
cached, so untouched targets are never read and touched ones are read once.

TypeScript cannot infer what a function throws, so you list the error classes a
route maps, and `matchErrors` gives you one handler per class:

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

- The handler keys come from each class's literal `_tag`, or else its literal
  `name` (declare it `override readonly name = 'X' as const`; a plain
  `this.name = 'X'` is typed `string` and does not count). The map is
  **exhaustive**: a missing key, an extra key, a class without a literal tag, or two
  classes with the same tag is a compile error. Each handler gets its own class's
  instance (`e.sku`).
- A thrown error is matched against the classes in list order, by `instanceof`, so
  list a subclass before its parent. Non-`Error` throws skip the arms.
- Return `rethrow()` from a handler to pass the error on to the next arm, or, if
  there is none, to rethrow it.
- `handle` **widens the result type with each handler's response**. Because those
  responses flow into the value returned to `router.openapi(...)`, a handler that
  emits a status the route did not declare in `responses` is a **compile error**:
  the OpenAPI contract and the runtime handler cannot drift apart. Without arms,
  `handle` returns exactly the body's promise.

`matchErrors` returns a plain list of error arms. The primitive is
`onError(ErrorClass, (err, c) => response)`, one arm that matches errors that are
`instanceof ErrorClass`. Use it for a single arm, for a class without a literal tag,
or for arms shared across routes, and mix both forms in one list:

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

Arms are tried in order, and an arm that returns `rethrow()` defers to the next one.

The client types that `hc` and `testClient` see come from the route's `responses`, not
from the handler. `handle` and its arms are checked against `responses`, so the two
agree.

`handleErrors(body, arms, c)` is the same dispatch without the input proxy, for
when you only need the error handling. Arms are reusable — factor common ones
(`recordNotFoundArm`, `uniqueViolationArm`, ...) into helpers that call `onError`.

## Testing

`testClient` from `hono/testing` calls the app in-process with the same typed
client as `hc`. Build the app from the root thunk: the children's routes are part of
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

Call the client on the root app. A child thunk on its own, as in `testClient(thingRouter())`,
has full-path types but serves its routes at its own segment, without the parent's
middlewares. Statuses that a `routeMiddleware` returns, such as the 403 from
`createScopeMiddleware`, are typed only if the route (or `routeDefaults`) declares them.
Pass `children` inline (or `as const`): a children array stored in a variable typed
`(() => OpenAPIHono)[]` keeps the runtime routes but drops them from the type. An
unannotated variable that mixes different thunks (`const kids = [things, thingById]`)
can also collapse to one element type and lose some children's routes from the type.
A factory that registers its routes as statements and does not return the chain keeps
its children's routes in the app type but loses its own: return `router.openapi(...)`.
`app.request(path, init)` is the untyped fallback.

## Extending the `define[x]` context

`extendRouteContext` adds custom, type-safe builder methods to `defineRootRoute`
and `defineChildRoute` — generalizing the "load `:id` once, expose it on `c.var`"
pattern into a first-class method. Each method threads the route's path and
accumulated vars, and the augmentation is re-applied automatically through
`.middleware()` and through the methods' own return values, so the builders are
never lost mid-chain.

Describe the extended context as a self-referential interface extending
`RouteContextBase`, pair it with a one-line `RouteContextKind`, then pass the kind
as the type argument and the runtime builders as the argument:

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

The `key` guard rejects redeclaring an existing var, and `param` is constrained to
the route's path parameters — both enforced at the type level. The extended
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

`orgContext` is a variable on purpose: when `defineChildRoute(rootRoute, …)` is nested inline in the `bindOrganization(…)` call, `P` infers as `string`, so `ParamKeys<P>` is `never` and the param name is rejected. The curried form works inline.

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
`inspectRoutes` (from `hono/dev`) and stack traces show a middleware by its function
name. An inline arrow returned from a
factory has no name, so return a named function expression (or set the name with
`Object.defineProperty(fn, 'name', { value: '...' })`):

```ts
const makeRouter = createRouter({
  routeMiddleware: (route) =>
    async function auditLog(c, next) {
      await next();
    },
});
```

`createScopeMiddleware` already names its middleware, e.g. `requireScopes:things.read`.

**Report the declared route to OpenTelemetry.** `@hono/otel` names the span from
the handler that was running when the response was produced. If a context
middleware (registered on the whole subtree) returns a 401, the span reads
`GET /api/things/*` instead of `GET /api/things`. Take the first matched route
that is not a subtree middleware instead (`getRoute` needs `@hono/otel` >= 1.2.0),
and register the instrumentation before mounting routes, because Hono runs
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

`find` picks the outermost method-specific match. It is a heuristic: with
overlapping routes such as `/items/me` and `/items/:id` it reports the one Hono
registered first.

## Scaling

Type-checking cost grows linearly with the number of routes: about 27 ms per route
on TypeScript 5.9, and about 4x less on TypeScript 7.

The expensive part is the number of routers with a **unique `Variables` type**
(the vars of the router's context). The first time TypeScript sees one, it does
about 60k type instantiations (about 8 MB of memory), mostly inside
`@hono/zod-openapi`'s response typing. Routers that share a context type share
that cost. With 2 routes per router and a unique context per router, TypeScript
5.9 can run out of its default 4 GB heap somewhere between 400 and 600 routes.

Mitigations, in order of preference:

- Put more routes in each router: one router per resource (collection and item
  routes together) instead of one per endpoint.
- For per-resource vars, augment Hono's `ContextVariableMap` instead of adding
  them with `.middleware<Vars>()`. The routers then share one `Variables` type.
  The trade-off: every handler sees those vars as typed, even where no
  middleware sets them.
- Give the compiler more memory: `NODE_OPTIONS=--max-old-space-size=8192`.
- Use TypeScript 7, which is faster and uses less memory.

## Migrating from 0.x

The 0.x names still work in 1.x. They are marked `@deprecated` and will be removed in 2.0.

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

[`CHANGELOG.md`](./CHANGELOG.md) is the canonical list of 1.0 changes, including the type-level breaking changes and their migration notes.

## Documentation

- [`docs/usage.md`](./docs/usage.md) — copy-pastable examples: CRUD resources, nested children, serving, OpenAPI UI, opt-outs, testing.
- [`docs/api.md`](./docs/api.md) — full signature reference.
- [`docs/design.md`](./docs/design.md) — rationale and deliberate omissions.

## License

MIT
