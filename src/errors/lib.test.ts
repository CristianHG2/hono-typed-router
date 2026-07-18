import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { handleErrors, on, rethrow } from './lib';

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
