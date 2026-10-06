# hono-typed-router

## 1.0.0

This is the first stable release of `hono-typed-router`. It changes some names and types of 0.x, so read [Migrating from 0.x](docs/usage.md#migrating-from-0x) before you upgrade.

### Major Changes

- 3871d2f: Breaking (mostly type-level: code that compiled against 0.x can get new type errors; runtime behaviour is unchanged unless stated):

  - `routeDefaults` (formerly `base`) merge types now follow the runtime merge:
    - Merged arrays are element unions, `(A[number] | B[number])[]`, not tuples. The runtime deduplicates, so no tuple length is promised.
    - A route key whose type includes `undefined` widens to include the default's type, because the runtime keeps the default for an absent key and copies an explicit `undefined`.
    - A route `security: []` opts out of `routeDefaults.security`, at the type level and at runtime (OpenAPI semantics). Before, it was merged with the default, so the route still required the default scopes. Other empty arrays, such as `tags: []`, are still additive.
    - A router with no `routeDefaults` returns the route config type unchanged (it keeps its `?` modifiers).
    - Known limitation: with non-empty `routeDefaults`, `?` modifiers are still not kept through the merge.
    - `DeepMerge<never, X>` is now `never`.
  - `RouteMiddlewareFactory` and `transformRoute` now take two parameters: `(route, meta)`. Implementations with one parameter still compile, but code that _calls_ a factory directly, such as `createScopeMiddleware(opts)(route)` in a unit test, must now pass a `meta` (`{ path }`) argument.
  - The `HandlerFn` type is removed. Use `typeof handle` if you need the function type.
  - `RouteContext` gains an optional internal `segment` member. Code that builds `RouteContext` objects by hand should spread the original context rather than list its fields.
  - Runtime behaviour changes shipped as fixes in this release (see the patch notes): `jsonRequest`/`makeHonoJsonRequest` mark the body `required`, so a body-less request now gets 400 instead of reaching the handler with `{}`; route middleware now runs for HEAD requests and for routes whose path uses OpenAPI `{param}` syntax.

  Migration:

  - `makeHonoResponse` → `jsonResponse`
  - `makeHonoJsonBody` → `jsonBody`
  - `makeHonoJsonRequest` → `jsonRequest`
  - `makeHonoNoContentResponse` → `emptyResponse`
  - `createRouter({ base })` → `createRouter({ routeDefaults })`
  - `handler(c, fn).errors([on(E, f)])` → `handle(c, fn, [onError(E, f)])`, and `handler(c, fn)` → `handle(c, fn)`
  - The old names remain as deprecated aliases until 2.0.
  - If a route used `security: []` and relied on still getting the default `security`, remove the empty array.

- **Breaking:** `createScopeMiddleware` now types `c.var` in `resolve` and `onForbidden`. Without a type argument or a context, `c.var` has no vars, so `createScopeMiddleware({ resolve: (c) => c.var.session.scopes })` is now a compile error. Before, `c.var` was `any`, and a misspelled var gave a 500 error at runtime.

  To migrate, give the vars in one of these two forms:

  - Give the vars as a type argument: `createScopeMiddleware<SessionVars>({ resolve: (c) => c.var.session.scopes })`.
  - Give the context that sets the vars: `createScopeMiddleware(apiContext, { resolve: (c) => c.var.session.scopes })`. Only the type of the context is used.

  A route without scopes in `security` now gets no scope middleware. Before, it got a no-op `requireScopes` middleware.

- A `makeRouter` call without children is a type error when its callback returns an app with no typed routes, for example when it registers routes in separate statements and then returns `app`. Return the `.openapi()` chain, or return nothing; with children, `({ app }) => app` stays legal.
- `.middleware(mw)` now accepts reusable typed middleware: `createMiddleware<{ Variables: X }>` fits each context, and `ContextEnv<typeof ctx, X>` fits `ctx` and its descendants with more vars. Both add only `X`.

  **Breaking:**

  - `ContextEnv` has two new type-only keys, `READS` (the vars of the context) and `SETS` (the new vars). Exact-type assertions on a `ContextEnv` type change.
  - `.middleware<X>(mw)` with a `ContextEnv` middleware is now an error, and the message says that `[READS]` and `[SETS]` are missing. To fix it, remove the type argument.
  - A `ContextEnv` middleware that sets a var that the context already has is now an error: `Cannot redeclare existing var`.

  A chain of `ContextEnv` middlewares, each typed from the previous context, now type-checks in linear time.

### Minor Changes

- 3871d2f: Added:

  - `handle(c, fn, arms?)`: runs a handler body with the validated-input proxy and optional error arms, and returns a plain promise. Without arms its type is exactly `Promise<R>`; with arms it is widened with each arm's response, so an undeclared arm status is a compile error inside `app.openapi`.
  - `onError(ErrorClass, fn)`: declares an error arm (the new name of `on`).
  - `jsonResponse`, `jsonBody`, `jsonRequest`, `emptyResponse`: the new names of the schema helpers (positional arguments, same output).
  - `createRouter({ routeDefaults })`: the new name of `base`. If both are set, `routeDefaults` is used.
  - Value-form `defineChildContext(parent, path)` on the base and the extended (`extendRouteContext`) entry points. It infers the parent's path and vars from the value, and the child's runtime `path` is `parent.path + path` (the full path whenever every ancestor is a root or a value-form child). The curried form `defineChildContext<typeof parent>()(path)` stays, not deprecated, for layouts where the parent module imports the child's router (a circular import).
  - `RouteMeta`: `routeMiddleware` factories and `transformRoute` receive a second argument, `meta`, whose `path` is the context path joined with the route's path (Hono `:param` syntax, computed before `transformRoute`). One-argument hooks keep working.
  - `matchErrors([CartNotFound, OutOfStock], { CartNotFound: fn, OutOfStock: fn })`: declares one error arm per class with an exhaustive handler map, keyed by each class's literal `_tag` (else literal `name`). A missing key, an extra key, a class without a literal tag, or two classes with the same tag is a compile error. It returns an arm tuple that `handle(c, fn, arms)` and `handleErrors` accept as is, so an undeclared handler status is still a compile error inside `app.openapi`. Also exports the `ErrorCtor`, `ErrorTag` and `MatchHandlers` types.
  - Typed `children` schemas: `makeRouter(context, callback, children)` takes `children` as a `const` type parameter, and the built app's type includes each child's route schemas, so `hc` and `testClient` on the root app see the children's routes at their full paths. Pass `children` inline or `as const`; an array in an annotated variable (`(() => OpenAPIHono)[]`) keeps the routes at runtime but drops them from the type.

  Deprecated (removed in 2.0):

  - `makeHonoResponse`, `makeHonoJsonBody`, `makeHonoJsonRequest`, `makeHonoNoContentResponse`.
  - `createRouter({ base })`.
  - `handler(c, fn)`, `handler(c, fn).errors(arms)` and the `HandlerInvocation` type.
  - `on(ErrorClass, fn)`.

- 4f6be53: The callback of `makeRouter` now receives `defineRoute(method, config)`. It is the new name of `route(method, config)`. Hono's `router.route(path, app)` mounts an app, so the old name was easy to misread. `route` still works and holds the same function. It is marked `@deprecated` and version 2.0 removes it. To migrate, change `({ router, route })` to `({ app, defineRoute })` and change each `route(` call to `defineRoute(`. The `router` key is also deprecated: use `app`.
- The callback of `makeRouter` now receives the `OpenAPIHono` instance as `app`: write `({ app, defineRoute }) => app.openapi(...)`. The `router` key still holds the same instance; it is marked `@deprecated` and version 2.0 removes it.
- Rename `defineRootRoute` to `defineRootContext` and `defineChildRoute` to `defineChildContext`. The name now says what the function returns: a `RouteContext`. `defineRootRoute` and `defineChildRoute` stay as deprecated aliases until 2.0.
- Add `mountRouter(context, children)`. It builds the root app from a context and its child routers, and returns the app, so `makeRouter(root, ({ app }) => app, children)()` becomes `mountRouter(root, children)`.
- `defineRoute` builds `request.params` from the context path, so the handler gets `:id` and `:id{regex}` params typed and validated without a params schema, also the params of every parent of a mounted router and of a sub-path in `config.path`. An optional `:id?` is not added, because OpenAPI cannot show an optional path parameter; read it with `c.req.param('id')`. A declared `z.object` params schema keeps its key types, its config such as `.strict()`, and its refinements (with zod 4.1 or later), and gets the missing path params. When the route declares no params, `routeDefaults.request.params` gets them. A declared key that the path does not have is a compile error, and the handler proxy of `handle` shows only the validation targets that the route declares.
- Add `context.bind(key, param, load)` to each context. It loads a value from a path param into a new typed var, and returns `c.notFound()` when the loader gives `null` or `undefined`. When the request has no value for the param, it returns `c.notFound()` and does not call the loader. The key must be one string literal: a `string` key or a union key is a type error.
- 4f6be53: Add the `ContextEnv<typeof context, NewVars>` type. Pass it to `createMiddleware` from `hono/factory` to build a reusable middleware that reads the vars of a context and sets new vars, all typed.
- `defineRootContext(path, middlewares)` (deprecated name: `defineRootRoute`) now accepts two more shapes of the `middlewares` array. The first shape is typed middlewares with different `Variables`, for example `[a, b]` where `a` sets `{ a: string }` and `b` sets `{ b: number }`. The second shape is a pair where the vars of one middleware are a superset of the vars of the other, for example `[a, ab]` or `[ab, a]` where `ab` sets `{ a: string; b: number }`. Before this change, these arrays failed with TS2322. Now the vars of the root context are the intersection of the vars of all the middlewares. A middleware that declares only `Bindings` also no longer fails, and it adds no vars. Calls that compiled before keep their vars.

  These arrays stay compile errors, with a message:

  - Two middlewares that declare the same var with different types: `Middlewares in the array declare the same var with different types: <keys>`. Two middlewares that declare the same var with the same type are correct.
  - An array variable with mixed middlewares, such as `const list = [a, b]`: its element type is a union, so the vars cannot be found. Pass a tuple literal or `as const`. An array variable of one middleware type, or of untyped middlewares, is correct.

  The fold signature now also accepts a readonly tuple, such as an array variable with `as const`.

- A `makeRouter(...)` call written inline in the `children` array of a different `makeRouter` call now type-checks, and the outer router's type contains the routes of the inner router and of its children.

  Breaking change for explicit type arguments: `makeRouter<P, V, R>(context, callback, [])` with exactly three explicit type arguments compiled before. Now it gives TS2554, because the children type parameter has no default. To fix this, pass the children tuple type as a fourth type argument (`makeRouter<P, V, R, []>(context, callback, [])`), or remove the explicit type arguments.

- `app.openapi` now attaches the `routeMiddleware` of a route when it registers the route, so a route that you declare but do not register gets no middleware, and a middleware that the callback adds with `app.use` before `openapi` runs before it. A router with a `createRouter` option that changes a route (`routeDefaults` with a key, `routeMiddleware` with a factory, or `transformRoute`) throws a `TypeError` for a `createRoute` config or a config from another router's `defineRoute`, so set `hide` and the other route keys in `defineRoute` (breaking against the unreleased tree: a copy such as `{ ...route, hide: true }` throws). When the callback returns an app that is not the `app` it received, such as `app.basePath('/x')` or `new OpenAPIHono()`, and a declared route has route middlewares that were not attached, the router throws a `TypeError`. Return the `app` that the callback received, or register the routes on it.
- `makeRouter` and `mountRouter` reject a children array variable whose element type is one typed child router, because the app type can lose the routes of the other children. Pass the children inline or `as const`, or type the array as `ChildRouter[]` to opt out of the route types. An array of one router type, such as `routers.map(() => r)` or `(typeof r)[]`, is also rejected. Type it as `ChildRouter[]`. A generic helper that forwards children, such as `<T extends ChildRouter[]>(kids?: T) => makeRouter(api, ({ app }) => app, kids)`, is also rejected. Write `kids as ChildRouter[] | undefined` in the call.
- `makeRouter` and `mountRouter` throw a `TypeError` when a child with a param segment, such as `'/:id'`, is mounted before a sibling with a literal segment, such as `'/stats'`, and the param child gets a request of a sibling route: Hono matches in registration order. The check compares routes: a route or middleware of the param child collides with a sibling route when its path matches the path of the sibling route and the methods are the same (`HEAD` counts as `GET`, `ALL` counts as every method). So `'/:id'` with `GET /` before `'/stats'` with `GET /x` is accepted. When the param child or a descendant has middlewares that run for every method (`.bind()`, `.middleware()`, `app.use()`), or a route that `defineRoute` did not declare (such as a raw `app.get()`), every sibling route under its segment collides. The error names the sibling route, for example `GET '/api/stats'`.
- `defineRootContext` and `defineChildContext` (both forms, and the forms that `extendRouteContext` returns) now throw a `TypeError` when a segment of a context path starts with `{`, the OpenAPI `{param}` syntax, for example `hono-typed-router: defineRootContext: the path '/api/{id}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/api/:id'.`. Before, such a path compiled and returned 404. A Hono regex param such as `:id{[0-9]+}` is still accepted.
- `makeRouter` and `mountRouter` throw a `TypeError` when two routes have the same method and full path, for example two children that declare `GET '/api/things/:id'`. The check reads the routes that `defineRoute` declares and `app.openapi` registers, because the client type of a repeated path becomes `never`. Param names do not count: `GET '/a/:id'` and `GET '/a/:x'` are the same route for Hono (the first one gets every request), so they also throw, and the message names both paths and says that Hono gives every request to the first route. A param regex and the optional `?` marker count. A trailing slash counts: Hono routes `'/things'` and `'/things/'` apart, so they are two routes.
- 4f6be53: `makeRouter` now throws a `TypeError` when the router of a value-form child (`defineChildContext(parent, path)`, deprecated name: `defineChildRoute`) is mounted under a context that is neither its `parent` nor a `.middleware()` descendant of `parent`. Before, such a mount type-checked and served the child's routes without the parent's middlewares, so a child defined under an auth-protected parent and mounted elsewhere ran unprotected. A child of `root` can mount under `root.middleware(...)`, because that context runs more middleware, not less. A child of `root.middleware(...)` cannot mount under `root` or under a different `root.middleware(...)` branch. Curried children, routers called directly, and routers wrapped as `() => childRouter()` are not checked. If your app now throws at startup, mount the child's router under the router of the context that you passed as its parent, or of a `.middleware()` descendant of that context.
- The package exports the `RouteMeta` type (the `meta` argument of route hooks) and the `ChildRouter` type (the child router type). Earlier unreleased names, such as `RouteHookMeta`, have no aliases.
- Raise the `@hono/zod-openapi` peer dependency floor to `^1.6.2`. Earlier versions make type-checking much slower for routers with a unique `Variables` type; 1.6.2 removed that cost upstream.
- Raise the `zod` peer dependency floor to `^4.1.0`. `defineRoute` adds the missing path params to a declared params object with `safeExtend`, which keeps its refinements; zod 4.0 has no `safeExtend`, and its `extend` drops the refinements.
- A context now carries Cloudflare `Bindings`, the type of `c.env`. `RouteContext` has a third type parameter, `TBindings`, with the default `{}`, and a phantom `bindings` member: a type-only value, `{}` at runtime. Declare the bindings on the root context in one of two ways: give them as the third type argument, `defineRootContext<'/api', SessionVars, Env['Bindings']>('/api', [auth])`, or give middlewares that declare `Bindings` in the root array. The fold intersects their `Bindings`, as it does for the vars. A root array with a middleware that declares only `Bindings` now gives these bindings, and its vars stay `{}`.

  - Children get the bindings of their parent, in the value form and in the curried form of `defineChildContext`. Bindings do not go up to the parent, because Hono's `app.route()` keeps the `Env` of the parent app.
  - `c.env` has the bindings in the inline handler of `.middleware()`, in the loader of `.bind()`, in `resolve` and `onForbidden` of `createScopeMiddleware(context, options)`, and in the route handlers of `app.openapi()`. `ContextEnv` adds `Bindings` when the context has bindings.
  - `.middleware(middleware)` adds the `Bindings` of a reusable middleware to the bindings of the context. Nothing checks them there. Before, the `Bindings` were dropped.
  - Two middlewares in the root array that declare the same binding with different types are an error: `Middlewares in the array declare the same binding with different types: <keys>`. The same binding with the same type is correct.
  - The `Env` of the app is `{ Bindings: B; Variables: V }`, or `{ Variables: V }` when the bindings are empty. A context without bindings gives the same types as before.
  - **Breaking:** a middleware typed `{ Bindings: B; Variables: V }` in the root array or in `.middleware()` now gives bindings to the context, so the `Env` of the app is `{ Bindings: B; Variables: V }`. Hono's `Context<E>` accepts only an `Env` with the same `Bindings` and `Variables`, not a wider or narrower one. Thus a handler or a helper typed only `{ Variables: V }`, such as `RouteHandler<typeof r, { Variables: V }>` or `(c: Context<{ Variables: V }>) => ...`, is now a compile error (TS2345). To fix it, type it `{ Bindings: B; Variables: V }`.
  - On a context with bindings, `.middleware()` has a third signature for a middleware typed only with `Variables`. It gives the same result as on a context without bindings: the same middleware a second time adds no vars, and a wider `{ Variables: V & W }` middleware adds `W`.
  - With an explicit bindings type argument, each typed middleware in the root array must declare the same `Bindings`. A middleware typed only with `Variables` does not fit, because its `Env` has no `Bindings`. Add such a middleware with `.middleware()`.
  - Four explicit type arguments now select the fold signature of `defineRootContext`. Before, three did. The fold form with explicit type arguments has no use.
  - `makeRouter`, `mountRouter` and `createScopeMiddleware` take the bindings as a last type parameter with a default, so explicit type arguments do not change.
  - The contexts of `extendRouteContext` have no bindings.

- The duplicate check of `makeRouter` and `mountRouter` now also reads the `createRoute` configs that `app.openapi` registers on a router maker without options (or with options that change no route). It also reads a config without route middlewares from the `defineRoute` of another router. Before, the check did not see these configs, and Hono gave every request to the first route. Now two children that register the same `createRoute` config, or a `createRoute` config and a `defineRoute` route with the same method and full path, throw a `TypeError` when the router is built. Two configs with the same method and path in one callback also throw: `hono-typed-router: makeRouter: the callback declares GET '/api' twice. The client type of that path can become never. Declare each method and path once.` The same config that the callback registers two times is one route, as for a `defineRoute` config. The order check of the children does not change.

- The loader of `.bind()` must be able to return a value. A loader that returns only `null`, `undefined`, `void`, `never`, or a promise of one of these is a compile error: `The loader returns no value: return the value of the var, or null when there is none`. Before, such a loader compiled, and every request to the route got a 404. The check is on `RouteContext.bind` and on the `bind` of an extended context. `CheckBindLoader` is exported for declaration emit.

  - The check unwraps one level of `Promise`. It does not check a nested `Promise` or a custom thenable.
  - A loader whose return type is a type parameter compiles, so a generic wrapper over `.bind()` compiles. The check does not run through the wrapper: a call of the wrapper with a loader that returns only `null` also compiles.

- The contexts of `extendRouteContext` do not carry Cloudflare `Bindings`. Before, they dropped the bindings with no error. Now the calls that lose bindings are compile errors:

  - A child of a parent with bindings, in the value form or in the curried form of the extended `defineChildContext`, is an error: `Extended contexts do not carry Bindings: use defineChildContext from hono-typed-router for a child of a context with bindings`.
  - A middleware that declares `Bindings`, in the `.middleware()` of an extended context or in the array of the extended `defineRootContext`, is an error: `Extended contexts do not carry Bindings: use the contexts of hono-typed-router for a middleware with Bindings`.
  - A parent whose bindings have only optional keys, or are `Record<string, unknown>`, compiles. The child does not get these bindings.
  - A generic helper over a parent with a bindings type parameter compiles. The check does not run through the helper: a call of the helper with a parent that has bindings also compiles.
  - `BindingsSlot`, `CheckNoBindings`, `CheckExtendedMiddlewareFits`, `CheckNoRootBindings`, `NoBindingsMessage` and `NoMiddlewareBindingsMessage` are exported for declaration emit.

### Patch Changes

- When an error arm handler throws an `Error` that has no `cause`, `handleErrors` (and `handle`) now set the original error as its `cause`. Error logs then show both errors. A frozen error, or an error whose `cause` cannot be set, is rethrown unchanged. A module-level singleton error keeps the `cause` of its first throw.
- `defineRoute` infers its config as `const`, so `middleware: [a, b]` stays a tuple and the handler gets the vars of each middleware without `as const`. A `routeDefaults.middleware` tuple and a route `middleware` tuple merge into one tuple, and literal values such as `description` and `tags` keep their literal types.
- Internal tooling: `pnpm check:docs` (part of `pnpm check`) checks that each `ts` (or `typescript`) code block in `README.md`, `docs/usage.md` and `docs/api.md` has a compiled copy in `src/docs.test-d.ts`, `src/usage-docs.test-d.ts` or the new `src/api-docs.test-d.ts`. The examples of `docs/api.md` now compile in `test:types`. Signature-only blocks are marked `<!-- doc-check: skip -->`. An indented `ts` fence inside a list fails the check, because the checker does not read it. No change to the published API.
- Every runtime error of the router starts with `hono-typed-router:` and the name of the function that you called (`makeRouter`, `mountRouter` or `openapi`), so the mount guard reports `mountRouter:` for the children of `mountRouter`. The mount guard now throws a `TypeError` instead of an `Error`, and the messages say "callback" instead of "factory".
- A `routeMiddleware` factory can return `undefined` when a route needs no middleware. The router then attaches nothing for that factory, so `showRoutes` does not list a no-op middleware.
- 4f6be53: Fix type inference for a value-form `defineChildContext(parent, path)` call (deprecated name: `defineChildRoute`) nested inline as an argument of another generic function. For example, `bind(defineChildContext(root, '/orgs/:orgId'), 'orgId')` now infers the full path `'/api/orgs/:orgId'`. Before, the path type was `string`, so `ParamKeys<P>` was `never` and the param name was rejected. You no longer need to assign the child context to a variable first. The fix applies to the base `defineChildContext` and to the one from `extendRouteContext`.
- The helper types that the package exports only for declaration emit, such as `NoRedeclare`, `BindKey`, `ExtensionBuilders`, `AnyArm` and `MatchHandlers`, now have an `@internal` JSDoc tag. They are still exported and work as before, but they are not part of the public API, so do not write them in your code.
- When a `matchErrors` handler map has a key that is not the tag of a listed class, the error message now names the key and the listed tags. TypeScript can also report the parameters of that handler as implicit `any`.
- 4f6be53: `meta.path` is now the full URL path for a curried child (`defineChildContext<typeof parent>()(segment)`, deprecated name: `defineChildRoute`) that is mounted under its parent, not only its segment. The parent passes its full mount path to each child router when it mounts it. A value-form child of a curried parent also gets the full path. A router called directly, with no parent, still uses its context's path. Routing and the public router type (`() => app`) do not change. If a `transformRoute` hook derives `operationId` from `meta.path`, a mounted curried child now gets a different `operationId` (for example, `get__id` becomes `get_api_things_id`). A generated SDK uses these ids as method names, so the SDK methods for these routes get new names.
- The `package.json` description now uses the words of the glossary: "Path-typed router builder for Hono and @hono/zod-openapi, with typed middleware contexts and route middleware factories." The old text said "per-route policy hooks". The library has no policy hooks.
- 3871d2f: Fixed:

  - `routeMiddleware` (including `createScopeMiddleware`) did not run for HEAD requests to a GET route, and did not run at all for a route whose path uses the OpenAPI `{param}` syntax. Route middleware is now registered with `router.on(METHOD, path)` on the Hono form of the path.
  - `makeHonoJsonRequest` (now `jsonRequest`) sets `required: true`, so a request without a JSON body is validated instead of reaching the handler as `{}`.
  - `handler(c, fn).errors(arms)` ran the body a second time when the invocation had already been awaited.
  - A callback that forgot `return app` threw when children were mounted; it now falls back to the app.
  - The scope middleware is named (`requireScopes:a+b`), so route listings and stack traces no longer show `<anonymous>`.
  - The handler invocation is tagged `HandlerInvocation` (`Symbol.toStringTag`), so stack traces no longer read `Promise.then`.
  - The build sets `types: ["node"]` for TypeScript 7, which no longer loads `@types/*` automatically; without it hono's `Response` type resolved to `any` and response type errors were silently lost.
  - A child of a root `'/'` was typed with a double slash: `defineChildContext<typeof root>()('/things')` under `defineRootContext('/', [])` had the path type `'//things'` while it was served at `/things`. A parent path that ends in `/` now drops that slash when the child segment starts with one. The runtime path of the curried form is unchanged. The new value form `defineChildContext(root, '/things')` uses the same join at runtime and in the type (`'/things'`).
  - A child segment without a leading `/` was joined without one: `defineChildContext(defineRootContext('/api', []), 'x')` had the path `'/apix'` (type and runtime, so `meta.path` and the `testClient` key were wrong) while Hono served it at `/api/x`. The segment is now joined with `/`, in both forms: the path is `'/api/x'`, and the curried form's path type changes from `'/apix'` to `'/api/x'`.

- The `RETHROW` export is deprecated: return `rethrow()` from the arm instead, which gives the same sentinel. `RETHROW` is removed in 2.0, and the `Rethrow` type stays. `RETHROW` is the symbol that owns the `unique symbol` type, so a project with `declaration: true` can export an `onError` or `matchErrors` result: its `.d.ts` names the type as `typeof import('hono-typed-router').RETHROW`. Before, such an export failed with TS2527 (an inaccessible `unique symbol`).
- The `middlewares` argument of `defineRootContext(path, middlewares?)` and of its deprecated alias `defineRootRoute` is now optional. A root context without middlewares has no vars (`{}`).
- Internal tooling: `pnpm check:type-budget` runs in CI and fails when the type-checking cost grows by more than 10%. It checks the type instantiations of the type tests, and the instantiations of each route in a generated fixture of 50 routers with 2 routes each. The budget is in `tools/type-budget.json`. To accept an intended increase, run `pnpm check:type-budget --update` and commit the file. No change to the published API.
- A child segment of `'/'` or `''` now adds nothing to the path of the parent, as Hono's `basePath` and `route('/')` do. `defineChildContext(defineRootContext('/api', []), '/')` had the path `'/api/'` (type and runtime, so the `testClient` key was `/api/`), while Hono served its routes at `/api`, and `/api/` returned 404 in strict mode. The path is now `'/api'` in both forms. A parent that ends in `/` keeps its slash (`'/api/'` + `'/'` is `'/api/'`), and a root `''` with the segment `'/'` still gives `'/'`. The duplicate check of `makeRouter` and `mountRouter` now uses the same path. Before, the parent and a child at `'/'` could both declare `GET /api` without an error, and Hono gave every request to the route of the parent. Now this throws: `hono-typed-router: makeRouter: the callback and a child both declare GET '/api'.` Two children at `'/'` and `''` with the same route also throw. A real segment with a trailing slash, such as `'/things/'`, keeps its slash, so `/things` and `/things/` stay two different routes.
- `meta.path` now keeps the trailing slash of the mount path, as Hono's `mergePath` does. A child at `'/things/'` under `/api` with a route at `'/'` had `meta.path` `/api/things`, while Hono served the route at `/api/things/` and the duplicate check used `GET /api/things/`. Now `meta.path` is `/api/things/`, and the route `'/x'` gives `/api/things/x`. The duplicate check also uses the path that Hono registers for a route path `''` of a child at `'/'`. Before, the key was `GET /api/`, while Hono served the route at `/api`, so the parent and the child could both declare `GET /api` without an error. Now this throws: `hono-typed-router: makeRouter: the callback and a child both declare GET '/api'.`
- The compile error for a redeclared var now names the fix: `Cannot redeclare existing var: <key>. Use another var name, or read <key> from the context.` Before, the message was only `Cannot redeclare existing var: <key>`. When a middleware sets two vars that the context already has, each message names one var.
