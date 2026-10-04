---
'hono-typed-router': patch
---

Fix type inference for a value-form `defineChildRoute(parent, path)` call nested inline as an argument of another generic function. For example, `bind(defineChildRoute(root, '/orgs/:orgId'), 'orgId')` now infers the full path `'/api/orgs/:orgId'`. Before, the path type was `string`, so `ParamKeys<P>` was `never` and the param name was rejected. You no longer need to assign the child context to a variable first. The fix applies to the base `defineChildRoute` and to the one from `extendRouteContext`.
