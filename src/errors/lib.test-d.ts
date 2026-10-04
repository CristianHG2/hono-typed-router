import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import type { Context } from 'hono';
import { createRouter } from '../router';
import { defineRootRoute } from '../definitions';
import { jsonResponse } from '../factories';
import { handle } from '../handler';
import { matchErrors, onError, rethrow } from './lib';
import type { ErrorTag } from './lib';

class CartNotFound extends Error {
  readonly _tag = 'CartNotFound' as const;
}

class OutOfStock extends Error {
  readonly _tag = 'OutOfStock' as const;

  constructor(readonly sku: string) {
    super();
  }
}

class Legacy extends Error {
  override readonly name = 'Legacy' as const;
}

class Untagged extends Error {}

class SameTagAsCart extends Error {
  readonly _tag = 'CartNotFound' as const;
}

// Keys come from a literal `_tag`, else a literal `name`; `Error.prototype.name` does not count.
{
  expectTypeOf<ErrorTag<typeof CartNotFound>>().toEqualTypeOf<'CartNotFound'>();
  expectTypeOf<ErrorTag<typeof Legacy>>().toEqualTypeOf<'Legacy'>();
  expectTypeOf<ErrorTag<typeof Untagged>>().toBeNever();
}

// Each handler gets its own class's instance.
{
  matchErrors([CartNotFound, OutOfStock, Legacy], {
    CartNotFound: (e) => expectTypeOf(e).toEqualTypeOf<CartNotFound>(),
    OutOfStock: (e) => expectTypeOf(e.sku).toEqualTypeOf<string>(),
    Legacy: (e, c) => {
      expectTypeOf(e).toEqualTypeOf<Legacy>();
      expectTypeOf(c).toEqualTypeOf<Context>();

      return rethrow();
    },
  });
}

// Exhaustive: a missing key is a compile error.
{
  matchErrors(
    [CartNotFound, OutOfStock],
    // @ts-expect-error — `OutOfStock` has no handler
    { CartNotFound: () => 'nf' },
  );
}

// No extra keys: a key with no matching class is a compile error.
{
  matchErrors([CartNotFound], {
    CartNotFound: () => 'nf',
    // @ts-expect-error — no class in the list has the tag `Nope`
    Nope: () => 'nope',
  });
}

// A class with neither a literal `_tag` nor a literal `name` is rejected in the class list.
{
  matchErrors(
    // @ts-expect-error — `Untagged` needs a literal `_tag` or `name`
    [CartNotFound, Untagged],
    { CartNotFound: () => 'nf' },
  );
}

// Two classes with the same tag are rejected in the class list.
{
  matchErrors(
    // @ts-expect-error — `SameTagAsCart` repeats the tag `CartNotFound`
    [CartNotFound, SameTagAsCart],
    { CartNotFound: () => 'nf' },
  );
}

// `handle(c, fn, matchErrors(...))` widens exactly like the equivalent `onError` arms; a
// rethrow-only handler (sync or async) adds nothing.
{
  const c = {} as Context;
  const body = async () => c.json({ ok: true }, 200);

  const viaMatch = handle(
    c,
    body,
    matchErrors([CartNotFound, OutOfStock, Legacy], {
      CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
      OutOfStock: async (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
      Legacy: async () => rethrow(),
    }),
  );

  const viaOnError = handle(c, body, [
    onError(CartNotFound, (_e, ec) => ec.json({ message: 'Cart not found' }, 404)),
    onError(OutOfStock, async (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409)),
    onError(Legacy, async () => rethrow()),
  ]);

  expectTypeOf(viaMatch).toEqualTypeOf<typeof viaOnError>();

  // Spreading next to an `onError` arm keeps both arms' responses.
  const spread = handle(c, body, [
    ...matchErrors([CartNotFound], {
      CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
    }),
    onError(Error, (_e, ec) => ec.json({ message: 'boom' }, 500)),
  ]);

  const spreadViaOnError = handle(c, body, [
    onError(CartNotFound, (_e, ec) => ec.json({ message: 'Cart not found' }, 404)),
    onError(Error, (_e, ec) => ec.json({ message: 'boom' }, 500)),
  ]);

  expectTypeOf(spread).toEqualTypeOf<typeof spreadViaOnError>();
}

const ok = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const notFound = jsonResponse(z.object({ message: z.string() }), 'Not Found');

const ctx = defineRootRoute('/api', []);

// Inside `router.openapi`: declared statuses type-check, an undeclared one does not.
createRouter()(ctx, ({ router, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok, 404: notFound } });

  router.openapi(declared, (c) =>
    handle(
      c,
      async () => c.json({ ok: true }, 200),
      matchErrors([CartNotFound, Legacy], {
        CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
        Legacy: () => rethrow(),
      }),
    ),
  );

  router.openapi(declared, (c) =>
    // @ts-expect-error — the 409 handler response is absent from `responses`
    handle(
      c,
      async () => c.json({ ok: true }, 200),
      matchErrors([CartNotFound, OutOfStock], {
        CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
        OutOfStock: (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
      }),
    ),
  );

  return router;
});
