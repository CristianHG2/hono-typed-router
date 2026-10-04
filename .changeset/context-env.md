---
'hono-typed-router': minor
---

Add the `ContextEnv<typeof ctx, NewVars>` type. Pass it to `createMiddleware` from `hono/factory` to build a reusable middleware that reads the vars of a context and sets new vars, all typed.
