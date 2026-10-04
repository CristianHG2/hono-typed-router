---
'hono-typed-router': patch
---

`meta.path` is now the full URL path for a curried child (`defineChildRoute<typeof parent>()(segment)`) that is mounted under its parent, not only its segment. The parent passes its full mount path to each child thunk when it mounts it. A value-form child of a curried parent also gets the full path. A thunk called directly, with no parent, still uses its context's path. Routing and the public thunk type (`() => app`) do not change. If a `transformRoute` hook derives `operationId` from `meta.path`, a mounted curried child now gets a different `operationId` (for example, `get__id` becomes `get_api_things_id`). A generated SDK uses these ids as method names, so the SDK methods for these routes get new names.
