import { expectTypeOf } from 'expect-type';
import { defineChildRoute, defineRootRoute } from './lib';
import type { RouteContext } from './types';

// Root context preserves the literal path type
{
  const ctx = defineRootRoute('/api', []);
  expectTypeOf(ctx).toMatchTypeOf<RouteContext<'/api', {}>>();
  expectTypeOf(ctx.path).toEqualTypeOf<'/api'>();
}

// `middleware()` adds vars to the context
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(async (_c, next) => {
    await next();
  });

  expectTypeOf(ctx).toMatchTypeOf<RouteContext<'/api', { user: { id: string } }>>();
  expectTypeOf(ctx.vars).toMatchTypeOf<{ user: { id: string } }>();
}

// `middleware()` rejects redeclaration of existing vars
{
  const ctx = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(async (_c, next) => {
    await next();
  });

  // @ts-expect-error — redeclaring `user` must produce a guard string, not a valid handler
  ctx.middleware<{ user: { id: number } }>(async (_c, next) => {
    await next();
  });
}

// `defineChildRoute` concatenates the parent path with the child path
{
  const parent = defineRootRoute('/api', []);
  const child = defineChildRoute<typeof parent>()('/things');
  expectTypeOf(child.path).toEqualTypeOf<'/api/things'>();

  const grandchild = defineChildRoute<typeof child>()('/:id');
  expectTypeOf(grandchild.path).toEqualTypeOf<'/api/things/:id'>();
}

// Child routes inherit the parent's vars
{
  const parent = defineRootRoute('/api', []).middleware<{ user: { id: string } }>(
    async (_c, next) => {
      await next();
    },
  );
  const child = defineChildRoute<typeof parent>()('/things');
  expectTypeOf(child.vars).toMatchTypeOf<{ user: { id: string } }>();
}
