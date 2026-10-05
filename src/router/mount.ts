import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RouteContext } from '../definitions';
import type { RouterEnv } from '../definitions/env';
import { mountingRouter } from './lib';
import type { CheckChildren, ChildRouter, ChildSchema, WithChildSchemas } from './children';

/**
 * Builds the root app from a context and its children, and returns the built app (not a
 * thunk). It is the short form of `makeRouter(context, ({ app }) => app, children)()`
 * and uses the same code path. The router applies the context's middlewares, uses the
 * context's base path, and mounts each child with the same mount argument. Thus the mount
 * guard, the duplicate-route and children-order checks, and the full `meta.path` work as
 * with `makeRouter`. Their errors name `mountRouter`.
 *
 * This router declares no routes, so it takes no `createRouter` options. Each child keeps
 * the options of the `makeRouter` that built it. Use `makeRouter` when the root declares
 * routes of its own. The result is an app, not a thunk, so you cannot pass it as a child.
 */
export function mountRouter<
  TPath extends string,
  TVars extends object,
  const TChildren extends readonly ChildRouter[],
  TBindings extends object = {},
>(
  context: RouteContext<TPath, TVars, TBindings>,
  children: TChildren & CheckChildren<TChildren>,
): WithChildSchemas<OpenAPIHono<RouterEnv<TVars, TBindings>>, ChildSchema<TChildren[number]>> {
  // `children` passed `CheckChildren` in this signature. As a plain `ChildRouter[]`, it does
  // not go through a second check, which TypeScript cannot reduce for a generic type.
  const list: readonly ChildRouter[] = children;

  // SAFETY: the bindings of a context are a phantom type. The runtime context is the same
  // for each bindings type, and `mountingRouter` does not read them.
  const base: RouteContext<string, object> = context as never;

  // SAFETY: the factory returns the app, so the result is the app with the routes of the
  // children, as the return type states. `never` instead of the return type: a cast to
  // `WithChildSchemas` costs about 140,000 type instantiations in this module.
  return mountingRouter(base, ({ app }) => app, list)() as never;
}
