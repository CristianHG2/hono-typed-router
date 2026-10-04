---
'hono-typed-router': minor
---

The router factory now receives `defineRoute(method, config)`. It is the new name of `route(method, config)` and matches `defineRootRoute` and `defineChildRoute`. Hono's `router.route(path, app)` mounts an app, so the old name was easy to misread. `route` still works and holds the same function. It is marked `@deprecated` and version 2.0 removes it. To migrate, change `({ router, route })` to `({ router, defineRoute })` and change each `route(` call to `defineRoute(`.
