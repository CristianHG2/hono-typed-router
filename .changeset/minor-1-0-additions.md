---
'hono-typed-router': minor
---

Added:

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
