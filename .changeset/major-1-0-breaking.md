---
'hono-typed-router': major
---

Breaking (mostly type-level: code that compiled against 0.x can get new type errors; runtime behaviour is unchanged unless stated):

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
