import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import type { Context } from 'hono';
import { createRouter } from '../router';
import { defineRootContext } from '../definitions';
import { jsonResponse } from '../factories';
import { handle } from '../handler';
import { matchErrors, onError, rethrow } from './lib';
import type { CheckErrorCtors, ErrorTag } from './lib';

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

// A key comes from a literal `_tag`, else from a literal `name`. `Error.prototype.name` does not count.
{
  expectTypeOf<ErrorTag<typeof CartNotFound>>().toEqualTypeOf<'CartNotFound'>();
  expectTypeOf<ErrorTag<typeof Legacy>>().toEqualTypeOf<'Legacy'>();
  expectTypeOf<ErrorTag<typeof Untagged>>().toBeNever();
}

// Each handler gets an instance of its own class.
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

// A missing key is a compile error.
{
  matchErrors(
    [CartNotFound, OutOfStock],
    // @ts-expect-error `OutOfStock` has no handler
    { CartNotFound: () => 'nf' },
  );
}

// A key without a matching class is a compile error. The message names the key and the
// listed tags.
{
  matchErrors([CartNotFound], {
    CartNotFound: () => 'nf',
    // @ts-expect-error "Nope" is not the tag of a listed class. The tags are: CartNotFound
    Nope: () => 'nope',
  });

  // A misspelled tag: the error is on the misspelled key.
  matchErrors([CartNotFound, OutOfStock], {
    CartNotFound: () => 'nf',
    // @ts-expect-error "OutOfStok" is not the tag of a listed class. The tags are: CartNotFound, OutOfStock
    OutOfStok: () => 'oos',
  });
}

// The class list rejects a class without a literal `_tag` or a literal `name`.
{
  matchErrors(
    // @ts-expect-error `Untagged` needs a literal `_tag` or `name`
    [CartNotFound, Untagged],
    { CartNotFound: () => 'nf' },
  );

  expectTypeOf<
    CheckErrorCtors<[typeof CartNotFound, typeof Untagged]>[1]
  >().toEqualTypeOf<'Error class at index 1 needs a literal _tag or name'>();
}

// The class list rejects two classes with the same tag.
{
  matchErrors(
    // @ts-expect-error `SameTagAsCart` repeats the tag `CartNotFound`
    [CartNotFound, SameTagAsCart],
    { CartNotFound: () => 'nf' },
  );

  expectTypeOf<
    CheckErrorCtors<[typeof CartNotFound, typeof SameTagAsCart]>[1]
  >().toEqualTypeOf<'Error class at index 1 shares the tag "CartNotFound" with another class'>();
}

// `handle(c, fn, matchErrors(...))` gives the same type as the equal `onError` arms. A handler
// that only rethrows adds nothing.
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

  // A spread next to an `onError` arm keeps the responses of both arms.
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

const ctx = defineRootContext('/api', []);

// In `router.openapi`, a declared status compiles and an undeclared status is an error.
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
    // @ts-expect-error the 409 handler response is not in `responses`
    handle(
      c,
      async () => c.json({ ok: true }, 200),
      matchErrors([CartNotFound, OutOfStock], {
        CartNotFound: (_e, ec) => ec.json({ message: 'Cart not found' }, 404),
        OutOfStock: (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
      }),
    ),
  );
});
