# hono-typed-router

## 1.0.0

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

### Minor Changes

- 3871d2f: Added:

  - `handle(c, fn, arms?)`: runs a handler body with the validated-input proxy and optional error arms, and returns a plain promise. Without arms its type is exactly `Promise<R>`; with arms it is widened with each arm's response, so an undeclared arm status is a compile error inside `router.openapi`.
  - `onError(ErrorClass, fn)`: declares an error arm (the new name of `on`).
  - `jsonResponse`, `jsonBody`, `jsonRequest`, `emptyResponse`: the new names of the schema helpers (positional arguments, same output).
  - `createRouter({ routeDefaults })`: the new name of `base`. If both are set, `routeDefaults` is used.
  - Value-form `defineChildRoute(parent, path)` on the base and the extended (`extendRouteContext`) entry points. It infers the parent's path and vars from the value, and the child's runtime `path` is `parent.path + path` (the full path whenever every ancestor is a root or a value-form child). The curried form `defineChildRoute<typeof parent>()(path)` stays, not deprecated, for layouts where the parent module imports the child's router (a circular import).
  - `RouteHookMeta`: `routeMiddleware` factories and `transformRoute` receive a second argument, `meta`, whose `path` is the context path joined with the route's path (Hono `:param` syntax, computed before `transformRoute`). One-argument hooks keep working.
  - `matchErrors([CartNotFound, OutOfStock], { CartNotFound: fn, OutOfStock: fn })`: declares one error arm per class with an exhaustive handler map, keyed by each class's literal `_tag` (else literal `name`). A missing key, an extra key, a class without a literal tag, or two classes with the same tag is a compile error. It returns an arm tuple that `handle(c, fn, arms)` and `handleErrors` accept as is, so an undeclared handler status is still a compile error inside `router.openapi`. Also exports the `ErrorCtor`, `ErrorTag` and `MatchHandlers` types.
  - Typed `children` schemas: `makeRouter(context, factory, children)` takes `children` as a `const` type parameter, and the built app's type includes each child's route schemas, so `hc` and `testClient` on the root app see the children's routes at their full paths. Pass `children` inline or `as const`; an array in an annotated variable (`(() => OpenAPIHono)[]`) keeps the routes at runtime but drops them from the type.

  Deprecated (removed in 2.0):

  - `makeHonoResponse`, `makeHonoJsonBody`, `makeHonoJsonRequest`, `makeHonoNoContentResponse`.
  - `createRouter({ base })`.
  - `handler(c, fn)`, `handler(c, fn).errors(arms)` and the `HandlerInvocation` type.
  - `on(ErrorClass, fn)`.

### Patch Changes

- 3871d2f: Fixed:

  - `routeMiddleware` (including `createScopeMiddleware`) did not run for HEAD requests to a GET route, and did not run at all for a route whose path uses the OpenAPI `{param}` syntax. Route middleware is now registered with `router.on(METHOD, path)` on the Hono form of the path.
  - `makeHonoJsonRequest` (now `jsonRequest`) sets `required: true`, so a request without a JSON body is validated instead of reaching the handler as `{}`.
  - `handler(c, fn).errors(arms)` ran the body a second time when the invocation had already been awaited.
  - A factory that forgot `return router` threw when children were mounted; it now falls back to the router.
  - The scope middleware is named (`requireScopes:a+b`), so route listings and stack traces no longer show `<anonymous>`.
  - The handler invocation is tagged `HandlerInvocation` (`Symbol.toStringTag`), so stack traces no longer read `Promise.then`.
  - The build sets `types: ["node"]` for TypeScript 7, which no longer loads `@types/*` automatically; without it hono's `Response` type resolved to `any` and response type errors were silently lost.
  - A child of a root `'/'` was typed with a double slash: `defineChildRoute<typeof root>()('/things')` under `defineRootRoute('/', [])` had the path type `'//things'` while it was served at `/things`. A parent path that ends in `/` now drops that slash when the child segment starts with one. The runtime path of the curried form is unchanged. The new value form `defineChildRoute(root, '/things')` uses the same join at runtime and in the type (`'/things'`).
  - A child segment without a leading `/` was typed without one: `defineChildRoute<typeof api>()('x')` under `api = defineRootRoute('/api', [])` had the path type `'/apix'`, while Hono always served it at `/api/x`. The curried form's path type is now `'/api/x'`; its runtime path is unchanged. The new value form `defineChildRoute(api, 'x')` joins with `/` in both the type and the runtime path (`'/api/x'`).
