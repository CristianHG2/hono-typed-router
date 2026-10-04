---
'hono-typed-router': minor
---

`makeRouter` now throws an `Error` when the router of a value-form child (`defineChildRoute(parent, path)`) is mounted under a context that is neither its `parent` nor a `.middleware()` descendant of `parent`. Before, such a mount type-checked and served the child's routes without the parent's middlewares, so a child defined under an auth-protected parent and mounted elsewhere ran unprotected. A child of `root` can mount under `root.middleware(...)`, because that context runs more middleware, not less. A child of `root.middleware(...)` cannot mount under `root` or under a different `root.middleware(...)` branch. Curried children, thunks called directly, and thunks wrapped as `() => thunk()` are not checked. If your app now throws at startup, mount the child's router under the router of the context that you passed as its parent, or of a `.middleware()` descendant of that context.
