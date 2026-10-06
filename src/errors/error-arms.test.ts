import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { RETHROW, handleErrors, on, onError, rethrow } from './error-arms';

function makeContext() {
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

  return { json } as unknown as Context;
}

class FooError extends Error {
  constructor(message = 'foo') {
    super(message);
    this.name = 'FooError';
  }
}

class BarError extends Error {
  constructor(message = 'bar', options?: ErrorOptions) {
    super(message, options);
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

function throwing(err: unknown) {
  return async () => {
    throw err;
  };
}

const throwText = throwing('text');

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
    // This test uses the deprecated `RETHROW` on purpose. It must stay equal to `rethrow()`.
    expect(RETHROW).toBe(rethrow());
    const first = vi.fn(() => RETHROW);
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

  it('sets the original error as the cause of an error that an arm handler throws', async () => {
    const original = new FooError();
    const thrown = new BarError();
    const arms = [onError(FooError, () => Promise.reject(thrown))] as const;

    await expect(handleErrors(() => Promise.reject(original), arms, makeContext())).rejects.toBe(
      thrown,
    );
    expect(thrown.cause).toBe(original);
  });

  it('keeps the cause of a thrown error that has one, and does not chain an error to itself', async () => {
    const original = new FooError();
    const earlier = new Error('earlier');
    const thrown = new BarError('bar', { cause: earlier });
    const withCause = [onError(FooError, () => Promise.reject(thrown))] as const;

    await expect(
      handleErrors(() => Promise.reject(original), withCause, makeContext()),
    ).rejects.toBe(thrown);
    expect(thrown.cause).toBe(earlier);

    const same = [onError(FooError, (err) => Promise.reject(err))] as const;

    await expect(handleErrors(() => Promise.reject(original), same, makeContext())).rejects.toBe(
      original,
    );
    expect(original.cause).toBeUndefined();
  });

  it('rethrows a frozen error unchanged and keeps the cause of a singleton error', async () => {
    const frozen = Object.freeze(new BarError());
    const throwFrozen = [onError(FooError, () => Promise.reject(frozen))] as const;

    await expect(
      handleErrors(() => Promise.reject(new FooError()), throwFrozen, makeContext()),
    ).rejects.toBe(frozen);
    expect(frozen.cause).toBeUndefined();

    class ReadOnlyCauseError extends Error {
      get cause(): unknown {
        return undefined;
      }
    }

    const readOnly = new ReadOnlyCauseError();
    const throwReadOnly = [onError(FooError, () => Promise.reject(readOnly))] as const;

    await expect(
      handleErrors(() => Promise.reject(new FooError()), throwReadOnly, makeContext()),
    ).rejects.toBe(readOnly);

    const singleton = new BarError();
    const first = new FooError();
    const throwSingleton = [onError(FooError, () => Promise.reject(singleton))] as const;

    await expect(
      handleErrors(() => Promise.reject(first), throwSingleton, makeContext()),
    ).rejects.toBe(singleton);
    await expect(
      handleErrors(() => Promise.reject(new FooError()), throwSingleton, makeContext()),
    ).rejects.toBe(singleton);
    expect(singleton.cause).toBe(first);
  });

  it('does not set a cause on a non-Error value that an arm handler throws', async () => {
    const arms = [onError(FooError, () => throwText())] as const;

    await expect(
      handleErrors(() => Promise.reject(new FooError()), arms, makeContext()),
    ).rejects.toBe('text');
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
