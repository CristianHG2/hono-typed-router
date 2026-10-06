import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RouteContext } from '../definitions';
import type { RouterEnv } from '../definitions/env';
import { mountingRouter } from './lib';
import type { CheckChildren, ChildRouter, ChildSchema, WithChildSchemas } from './children';

/**
 * Makes the root app from a context and its children. It is the short form of
 * `makeRouter(context, ({ app }) => app, children)()`, with the same checks. The result is an
 * app, not a thunk, so it cannot be a child.
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
  // A plain `ChildRouter[]` skips a second `CheckChildren`, which TypeScript cannot reduce
  // for a generic type.
  const list: readonly ChildRouter[] = children;

  // SAFETY: the bindings are a phantom, and `mountingRouter` does not read them.
  const base: RouteContext<string, object> = context as never;

  // SAFETY: the result is the app with the routes of the children. A cast to
  // `WithChildSchemas` costs about 140,000 type instantiations, so the cast is to `never`.
  return mountingRouter(base, ({ app }) => app, list)() as never;
}
