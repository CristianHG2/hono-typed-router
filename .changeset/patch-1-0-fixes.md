---
'hono-typed-router': patch
---

Fixed:

- `routeMiddleware` (including `createScopeMiddleware`) did not run for HEAD requests to a GET route, and did not run at all for a route whose path uses the OpenAPI `{param}` syntax. Route middleware is now registered with `router.on(METHOD, path)` on the Hono form of the path.
- `makeHonoJsonRequest` (now `jsonRequest`) sets `required: true`, so a request without a JSON body is validated instead of reaching the handler as `{}`.
- `handler(c, fn).errors(arms)` ran the body a second time when the invocation had already been awaited.
- A factory that forgot `return router` threw when children were mounted; it now falls back to the router.
- The scope middleware is named (`requireScopes:a+b`), so route listings and stack traces no longer show `<anonymous>`.
- The handler invocation is tagged `HandlerInvocation` (`Symbol.toStringTag`), so stack traces no longer read `Promise.then`.
- The build sets `types: ["node"]` for TypeScript 7, which no longer loads `@types/*` automatically; without it hono's `Response` type resolved to `any` and response type errors were silently lost.
- A child of a root `'/'` was typed with a double slash: `defineChildRoute<typeof root>()('/things')` under `defineRootRoute('/', [])` had the path type `'//things'` while it was served at `/things`. A parent path that ends in `/` now drops that slash when the child segment starts with one. The runtime path of the curried form is unchanged. The new value form `defineChildRoute(root, '/things')` uses the same join at runtime and in the type (`'/things'`).
- A child segment without a leading `/` was joined without one: `defineChildRoute(defineRootRoute('/api', []), 'x')` had the path `'/apix'` (type and runtime, so `meta.path` and the `testClient` key were wrong) while Hono served it at `/api/x`. The segment is now joined with `/`, in both forms: the path is `'/api/x'`, and the curried form's path type changes from `'/apix'` to `'/api/x'`.
