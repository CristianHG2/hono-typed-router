# Agent brief

`hono-typed-router` is a path-typed router builder for Hono and `@hono/zod-openapi`.

## Layout

- `src/definitions/`: contexts. `define-context.ts` has the context constructors, `bind.ts` has `.bind`, `extend.ts` has `extendRouteContext`, and `types.ts` has `RouteContext`.
- `src/router/`: the router maker and the router. `create-router.ts` has `createRouter`, `mount.ts` has `mountRouter`, and `mount-checks.ts` has the checks at mount time.
- `src/errors/`: the error arms and `matchErrors`, in `error-arms.ts`.
- `src/handler/`: `handle`, in `handle.ts`.
- `src/schema-helpers.ts`: the JSON schema helpers, for example `jsonResponse`.
- `src/scopes.ts`: `createScopeMiddleware`. It is the `./scopes` subpath export, not a part of `src/index.ts`.
- `src/index.ts`: the main export. It re-exports the folders and `schema-helpers.ts`.
- The import rule: `errors`, `definitions` and `schema-helpers` import no other `src` folder. `router` imports `definitions`. `handler` imports `errors`. `scopes` imports `router` and `definitions`. Nothing imports upward.

| Symbol                  | File in `src/`                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `makeRouter`            | `router/create-router.ts`, the closure in `createRouterImpl`. Type: `MakeRouterFn` in `router/types.ts`. |
| `defineRoute`           | A function in that closure. Type: `MakeRouteFn` in `router/types.ts`.                                    |
| `.bind`                 | Signatures: `definitions/types.ts` and `definitions/extend.ts`. Runtime: `definitions/bind.ts`.          |
| `mountRouter`           | `router/mount.ts`                                                                                        |
| `createScopeMiddleware` | `scopes.ts`                                                                                              |
| `handle`                | `handler/handle.ts`                                                                                      |
| `matchErrors`           | `errors/error-arms.ts`                                                                                   |

## Before a commit

- Run `pnpm check`. It runs the type check, the type tests, `check:docs`, lint, the format check, the tests, `check:type-budget`, and the build. CI runs `pnpm check`.
- Git hooks run the format check, lint, and `check:docs` on staged files. Commit messages use Conventional Commits.
- Add a changeset with `pnpm changeset` for each change to the package. Version 1.0.0 is not published yet, so each changeset folds into the 1.0.0 entry of `CHANGELOG.md` until it ships.

## Rules

- Each ```ts block in `README.md`, `docs/usage.md`, and `docs/api.md` has a twin in `src/docs.test-d.ts`, `src/usage-docs.test-d.ts`, and `src/api-docs.test-d.ts`. If you change a block, change its twin. Put `<!-- doc-check: skip -->` above a block that is only a signature.
- Each type assertion (`as`) needs a `// SAFETY:` comment above it. Lint enforces this.
- Return early. Do not put the rest of a function or a loop body in a final `if`. Invert the condition and use `return` or `continue`.
- Write each `if` statement with braces, also when its body is one statement.
- Write a named function as a `function` declaration, not as an arrow function in a `const`. Callbacks can stay arrow functions. `oxlint.config.ts` enforces these three rules.
- The library uses seven words for its concepts: context, route, middleware, route middleware factory, router maker, router, app. [README.md#concepts](README.md#concepts) defines them. Do not add a new word for a concept.
- Write docs and error messages in Simplified Technical English: short sentences, active voice, one word for one meaning.
- A runtime error message starts with `hono-typed-router: <function>:` and names the fix.
- A compile-time error message is a string literal in the types. A test in the `*.test-d.ts` file next to the check asserts the exact text.
- Read `docs/design.md` before you propose an API change. Its "Rejected designs" section lists the designs that the package does not use.
