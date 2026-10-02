import { expectTypeOf } from 'expect-type';
import type { MiddlewareHandler } from 'hono';
import { createRouter } from '../router';
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

  // @ts-expect-error — redeclaring `user` fails the `NoRedeclare` constraint on the type argument
  ctx.middleware<{
    user: { id: number };
  }>(async (c, next) => {
    // Contextual typing survives the guard: `c` is not an implicit `any`.
    expectTypeOf(c.var.user).toEqualTypeOf<{ id: string } & { id: number }>();
    await next();
  });
}

// Root vars default to `{}`, so a single middleware's vars display exactly
{
  const ctx = defineRootRoute('/api', []).middleware<{ session: { userId: string } }>(
    async (_c, next) => {
      await next();
    },
  );

  expectTypeOf(ctx.vars).toEqualTypeOf<{ session: { userId: string } }>();
}

// `middleware()` without a type argument adds no vars (`TNewVars` defaults to `{}`)
{
  const root = defineRootRoute('/api', []);

  const ctx = root.middleware(async (_c, next) => {
    await next();
  });

  expectTypeOf(ctx.vars).toEqualTypeOf<typeof root.vars>();
  expectTypeOf<keyof typeof ctx.vars>().toEqualTypeOf<never>();

  // A handler typed up front still contributes its vars without a type argument.
  const typed: MiddlewareHandler<{ Variables: { z: boolean } }> = async (_c, next) => {
    await next();
  };

  expectTypeOf(root.middleware(typed).vars).toMatchTypeOf<{ z: boolean }>();
}

// `middleware<{ a: string }>()` types `c.var.a` in later middleware and in route handlers
{
  const ctx = defineRootRoute('/api', [])
    .middleware<{ a: string }>(async (c, next) => {
      c.set('a', 'x');
      await next();
    })
    .middleware<{ b: number }>(async (c, next) => {
      expectTypeOf(c.var.a).toEqualTypeOf<string>();
      await next();
    });

  expectTypeOf<keyof typeof ctx.vars>().toEqualTypeOf<'a' | 'b'>();

  createRouter()(ctx, ({ router }) => {
    router.use(async (c, next) => {
      expectTypeOf(c.var.a).toEqualTypeOf<string>();
      expectTypeOf(c.var.b).toEqualTypeOf<number>();
      await next();
    });

    return router;
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

// `defineChildRoute` requires a parent with both `path` and `vars`
{
  // @ts-expect-error — `{ path: '/a' }` has no `vars`, so it fails the `ParentContext` constraint
  defineChildRoute<{ path: '/a' }>();

  // Any `{ path; vars }` shape works as a parent, not only a `RouteContext`.
  const child = defineChildRoute<{ path: '/a'; vars: { v: 1 } }>()('/b');
  expectTypeOf(child.path).toEqualTypeOf<'/a/b'>();
  expectTypeOf(child.vars).toEqualTypeOf<{ v: 1 }>();
}
