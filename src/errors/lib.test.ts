import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { handleErrors, matchErrors, on, onError, rethrow } from './lib';

const makeContext = () => {
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

  return { json } as unknown as Context;
};

class FooError extends Error {
  constructor(message = 'foo') {
    super(message);
    this.name = 'FooError';
  }
}

class BarError extends Error {
  constructor(message = 'bar') {
    super(message);
    this.name = 'BarError';
  }
}

class ParentError extends Error {
  constructor(message = 'parent') {
    super(message);
    this.name = 'ParentError';
  }
}

class ChildError extends ParentError {
  constructor(message = 'child') {
    super(message);
    this.name = 'ChildError';
  }
}

describe('handleErrors', () => {
  it('returns the body result when nothing throws', async () => {
    const c = makeContext();
    const result = await handleErrors(async () => 'ok', [], c);
    expect(result).toBe('ok');
  });

  it('runs the matching arm and returns its result', async () => {
    const c = makeContext();
    const handle = vi.fn((_err: FooError, ctx: Context) => ctx.json({ message: 'caught' }, 404));

    const result = await handleErrors(
      async () => {
        throw new FooError();
      },
      [on(FooError, handle)],
      c,
    );

    expect(handle).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ body: { message: 'caught' }, status: 404 });
  });

  it('rethrows when no arm matches', async () => {
    const c = makeContext();
    const handle = vi.fn();

    await expect(
      handleErrors(
        async () => {
          throw new BarError();
        },
        [on(FooError, handle)],
        c,
      ),
    ).rejects.toBeInstanceOf(BarError);
    expect(handle).not.toHaveBeenCalled();
  });

  it('tries the next arm when an arm returns RETHROW', async () => {
    const c = makeContext();
    const first = vi.fn(() => rethrow());
    const second = vi.fn((_err: FooError, ctx: Context) => ctx.json({ message: 'second' }, 409));

    const result = await handleErrors(
      async () => {
        throw new FooError();
      },
      [on(FooError, first), on(FooError, second)],
      c,
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ body: { message: 'second' }, status: 409 });
  });

  it('rethrows when all matching arms return RETHROW', async () => {
    const c = makeContext();
    const first = vi.fn(() => rethrow());
    const second = vi.fn(() => rethrow());

    await expect(
      handleErrors(
        async () => {
          throw new FooError('boom');
        },
        [on(FooError, first), on(FooError, second)],
        c,
      ),
    ).rejects.toBeInstanceOf(FooError);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('matches subclasses via instanceof', async () => {
    const c = makeContext();

    const handle = vi.fn((_err: ParentError, ctx: Context) =>
      ctx.json({ message: 'parent matched' }, 400),
    );

    const result = await handleErrors(
      async () => {
        throw new ChildError();
      },
      [on(ParentError, handle)],
      c,
    );

    expect(handle).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ body: { message: 'parent matched' }, status: 400 });
  });

  it('rethrows non-Error throws without consulting arms', async () => {
    const c = makeContext();
    const handle = vi.fn();

    await expect(
      handleErrors(
        async () => {
          throw 'not-an-error';
        },
        [on(Error, handle)],
        c,
      ),
    ).rejects.toBe('not-an-error');
    expect(handle).not.toHaveBeenCalled();
  });
});

class CartNotFound extends Error {
  readonly _tag = 'CartNotFound' as const;
}

class OutOfStock extends Error {
  readonly _tag = 'OutOfStock' as const;

  constructor(readonly sku: string) {
    super(`out of stock: ${sku}`);
  }
}

class Legacy extends Error {
  override readonly name = 'Legacy' as const;
}

// Tagged by `name`; its subclass adds a `_tag`, which is the only way a subclass can carry a
// different literal tag (TypeScript rejects overriding a literal `_tag`/`name` with another).
class Payment extends Error {
  override readonly name = 'Payment' as const;
}

class CardDeclined extends Payment {
  readonly _tag = 'CardDeclined' as const;
}

class BothTags extends Error {
  readonly _tag = 'FromTag' as const;

  override readonly name = 'FromName' as const;
}

// The `_tag` type is a literal, so `matchErrors` accepts the class, but no instance sets it at
// runtime: neither its `_tag` nor its `name` (`'Error'`) names a handler.
class Ghost extends Error {
  declare readonly _tag: 'Ghost';
}

const throwing = (err: unknown) => async () => {
  throw err;
};

describe('matchErrors', () => {
  it('returns one arm per class, in order', () => {
    const arms = matchErrors([CartNotFound, OutOfStock], {
      CartNotFound: () => 'nf',
      OutOfStock: () => 'oos',
    });

    expect(arms.map((arm) => arm.ctor)).toEqual([CartNotFound, OutOfStock]);
  });

  it('dispatches to the handler of the thrown class with the narrowed instance', async () => {
    const c = makeContext();
    const cartNotFound = vi.fn((_e: CartNotFound, ec: Context) => ec.json({ message: 'nf' }, 404));

    const arms = matchErrors([CartNotFound, OutOfStock, Legacy], {
      CartNotFound: cartNotFound,
      OutOfStock: (e, ec) => ec.json({ message: `Out of stock: ${e.sku}` }, 409),
      Legacy: () => rethrow(),
    });

    const result = await handleErrors(throwing(new OutOfStock('sku-1')), arms, c);

    expect(result).toEqual({ body: { message: 'Out of stock: sku-1' }, status: 409 });
    expect(cartNotFound).not.toHaveBeenCalled();
  });

  it('keys a class by its literal `name` when it has no `_tag`', async () => {
    const c = makeContext();

    const arms = matchErrors([Legacy], {
      Legacy: (e, ec) => ec.json({ message: e.name }, 410),
    });

    const result = await handleErrors(throwing(new Legacy()), arms, c);

    expect(result).toEqual({ body: { message: 'Legacy' }, status: 410 });
  });

  it('prefers `_tag` over `name` when the error has both', async () => {
    const c = makeContext();

    const arms = matchErrors([BothTags], {
      FromTag: (_e, ec) => ec.json({ message: 'tag' }, 400),
    });

    const result = await handleErrors(throwing(new BothTags()), arms, c);

    expect(result).toEqual({ body: { message: 'tag' }, status: 400 });
  });

  it('dispatches by declaration order: a subclass listed first wins', async () => {
    const c = makeContext();

    const declined = vi.fn((_e: CardDeclined, ec: Context) =>
      ec.json({ message: 'declined' }, 402),
    );

    const payment = vi.fn((_e: Payment, ec: Context) => ec.json({ message: 'payment' }, 400));

    const arms = matchErrors([CardDeclined, Payment], {
      CardDeclined: declined,
      Payment: payment,
    });

    expect(await handleErrors(throwing(new CardDeclined()), arms, c)).toEqual({
      body: { message: 'declined' },
      status: 402,
    });
    expect(await handleErrors(throwing(new Payment()), arms, c)).toEqual({
      body: { message: 'payment' },
      status: 400,
    });
    expect(declined).toHaveBeenCalledTimes(1);
    expect(payment).toHaveBeenCalledTimes(1);
  });

  it('picks the handler by the runtime tag when a parent is listed before its subclass', async () => {
    const c = makeContext();
    const payment = vi.fn((_e: Payment, ec: Context) => ec.json({ message: 'payment' }, 400));

    const arms = matchErrors([Payment, CardDeclined], {
      Payment: payment,
      CardDeclined: (_e, ec) => ec.json({ message: 'declined' }, 402),
    });

    const result = await handleErrors(throwing(new CardDeclined()), arms, c);

    expect(result).toEqual({ body: { message: 'declined' }, status: 402 });
    expect(payment).not.toHaveBeenCalled();
  });

  it("falls back to the parent's `name` key when the subclass `_tag` has no handler", async () => {
    const c = makeContext();

    const arms = matchErrors([Payment], {
      Payment: (e, ec) => ec.json({ message: e.constructor.name }, 400),
    });

    const result = await handleErrors(throwing(new CardDeclined()), arms, c);

    expect(result).toEqual({ body: { message: 'CardDeclined' }, status: 400 });
  });

  it('runs the handler once and falls through to the next arm after the tuple on rethrow()', async () => {
    const c = makeContext();
    const declined = vi.fn(() => rethrow());
    const payment = vi.fn(() => rethrow());
    const fallback = vi.fn((e: Error, ec: Context) => ec.json({ message: e.name }, 500));

    const arms = [
      ...matchErrors([CardDeclined, Payment], { CardDeclined: declined, Payment: payment }),
      onError(Error, fallback),
    ];

    const result = await handleErrors(throwing(new CardDeclined()), arms, c);

    expect(result).toEqual({ body: { message: 'Payment' }, status: 500 });
    expect(declined).toHaveBeenCalledTimes(1);
    expect(payment).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error when its handler rethrows and nothing else matches', async () => {
    const c = makeContext();
    const err = new Legacy();

    const arms = matchErrors([CartNotFound, Legacy], {
      CartNotFound: (_e, ec) => ec.json({ message: 'nf' }, 404),
      Legacy: () => rethrow(),
    });

    await expect(handleErrors(throwing(err), arms, c)).rejects.toBe(err);
  });

  it('rethrows errors that match no listed class', async () => {
    const c = makeContext();
    const err = new BarError();
    const arms = matchErrors([CartNotFound], { CartNotFound: () => 'nf' });

    await expect(handleErrors(throwing(err), arms, c)).rejects.toBe(err);
  });

  it('passes a listed error whose runtime tag names no handler to the next arm, else rethrows it', async () => {
    const c = makeContext();
    const err = new Ghost();
    const ghost = vi.fn(() => 'ghost');
    const fallback = vi.fn((e: Error, ec: Context) => ec.json({ message: e.message }, 500));

    await expect(
      handleErrors(throwing(err), matchErrors([Ghost], { Ghost: ghost }), c),
    ).rejects.toBe(err);

    const arms = [...matchErrors([Ghost], { Ghost: ghost }), onError(Error, fallback)];

    expect(await handleErrors(throwing(new Ghost('boo')), arms, c)).toEqual({
      body: { message: 'boo' },
      status: 500,
    });
    expect(ghost).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('propagates an error thrown by a handler without offering it to later arms', async () => {
    const c = makeContext();
    const handlerError = new Error('handler failed');
    const fallback = vi.fn(() => 'fallback');

    const arms = [
      ...matchErrors([CartNotFound], {
        CartNotFound: () => {
          throw handlerError;
        },
      }),
      onError(Error, fallback),
    ];

    await expect(handleErrors(throwing(new CartNotFound()), arms, c)).rejects.toBe(handlerError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('lets non-Error throws bypass the arms', async () => {
    const c = makeContext();
    const legacy = vi.fn();
    const arms = matchErrors([Legacy], { Legacy: legacy });

    await expect(handleErrors(throwing('not-an-error'), arms, c)).rejects.toBe('not-an-error');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('awaits async handlers, including an async rethrow()', async () => {
    const c = makeContext();

    const arms = [
      ...matchErrors([CartNotFound, OutOfStock], {
        CartNotFound: async (_e, ec) => ec.json({ message: 'nf' }, 404),
        OutOfStock: async () => rethrow(),
      }),
      onError(OutOfStock, (e, ec) => ec.json({ message: e.sku }, 409)),
    ];

    expect(await handleErrors(throwing(new CartNotFound()), arms, c)).toEqual({
      body: { message: 'nf' },
      status: 404,
    });
    expect(await handleErrors(throwing(new OutOfStock('sku-2')), arms, c)).toEqual({
      body: { message: 'sku-2' },
      status: 409,
    });
  });
});
