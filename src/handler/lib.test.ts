import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { on, onError, rethrow } from '../errors';
import { handle, handler } from './lib';

type FakeContext = Context & {
  req: { valid: ReturnType<typeof vi.fn> };
  json: ReturnType<typeof vi.fn>;
};

function makeContext(validated: Record<string, unknown> = {}): FakeContext {
  const valid = vi.fn((target: string) => validated[target]);
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }));

  return {
    req: { valid },
    json,
  } as unknown as FakeContext;
}

class RecordNotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'RecordNotFoundError';
  }
}

function recordNotFoundArm(message: string) {
  return onError(RecordNotFoundError, (_err, c) => c.json({ message }, 404));
}

describe('handle', () => {
  it('exposes validated inputs by target name via a destructurable proxy', async () => {
    const c = makeContext({ param: { id: 'x' }, json: { name: 'foo' } });

    const result = await handle(c, async ({ param, json }) => {
      const p = param as { id: string };
      const j = json as { name: string };

      return `${p.id}:${j.name}`;
    });

    expect(result).toBe('x:foo');
  });

  it('caches each target so c.req.valid is only called once per target', async () => {
    const c = makeContext({ param: { id: 'x' } });
    await handle(c, async ({ param }) => {
      void (param as { id: string }).id;
      void (param as { id: string }).id;

      return 'ok';
    });
    expect(c.req.valid).toHaveBeenCalledTimes(1);
    expect(c.req.valid).toHaveBeenCalledWith('param');
  });

  it('does not call c.req.valid for untouched targets', async () => {
    const c = makeContext({ param: { id: 'x' }, json: { name: 'foo' } });
    await handle(c, async ({ param }) => (param as { id: string }).id);
    expect(c.req.valid).toHaveBeenCalledTimes(1);
    expect(c.req.valid).toHaveBeenCalledWith('param');
  });

  it('returns the body result and rejects with its error when no arms are given', async () => {
    const c = makeContext({ json: { value: 42 } });

    const result = await handle(c, async ({ json }) =>
      c.json({ value: (json as { value: number }).value }, 200),
    );

    expect(result).toEqual({ body: { value: 42 }, status: 200 });
    await expect(
      handle(c, async () => {
        throw new RecordNotFoundError('missing');
      }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it('returns a plain promise that runs the body once', async () => {
    const c = makeContext();
    const body = vi.fn(async () => 'once');
    const result = handle(c, body);

    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe('once');
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('dispatches a thrown error to the matching arm', async () => {
    const c = makeContext();

    const result = await handle(c, async () => {
      throw new RecordNotFoundError('missing');
    }, [recordNotFoundArm('Not found')]);

    expect(result).toEqual({ body: { message: 'Not found' }, status: 404 });
  });

  it('returns the body result when no arm fires', async () => {
    const c = makeContext({ param: { id: 'x' } });

    const result = await handle(
      c,
      async ({ param }) => c.json({ id: (param as { id: string }).id }, 200),
      [recordNotFoundArm('Not found')],
    );

    expect(result).toEqual({ body: { id: 'x' }, status: 200 });
  });

  it('falls through an arm that rethrows to the next matching arm', async () => {
    const c = makeContext();
    const first = vi.fn(() => rethrow());

    const result = await handle(c, async () => {
      throw new RecordNotFoundError('missing');
    }, [onError(RecordNotFoundError, first), recordNotFoundArm('Second')]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ body: { message: 'Second' }, status: 404 });
  });

  it('rethrows when the thrown error matches no arm', async () => {
    const c = makeContext();
    await expect(
      handle(c, async () => {
        throw new Error('boom');
      }, [recordNotFoundArm('Not found')]),
    ).rejects.toThrow('boom');
  });

  it('passes non-Error throws through without consulting arms', async () => {
    const c = makeContext();
    const arm = vi.fn();

    await expect(
      handle(c, async () => {
        throw 'not-an-error';
      }, [onError(Error, arm)]),
    ).rejects.toBe('not-an-error');
    expect(arm).not.toHaveBeenCalled();
  });
});

describe('handler (deprecated)', () => {
  it('exposes validated inputs by target name via a destructurable proxy', async () => {
    const c = makeContext({ param: { id: 'x' }, json: { name: 'foo' } });

    const result = await handler(c, async ({ param, json }) => {
      const p = param as { id: string };
      const j = json as { name: string };

      return `${p.id}:${j.name}`;
    });

    expect(result).toBe('x:foo');
  });

  it('caches each target so c.req.valid is only called once per target', async () => {
    const c = makeContext({ param: { id: 'x' } });
    await handler(c, async ({ param }) => {
      void (param as { id: string }).id;
      void (param as { id: string }).id;
      void (param as { id: string }).id;

      return 'ok';
    });
    expect(c.req.valid).toHaveBeenCalledTimes(1);
    expect(c.req.valid).toHaveBeenCalledWith('param');
  });

  it('does not call c.req.valid for untouched targets', async () => {
    const c = makeContext({ param: { id: 'x' }, json: { name: 'foo' } });
    await handler(c, async ({ param }) => (param as { id: string }).id);
    expect(c.req.valid).toHaveBeenCalledTimes(1);
    expect(c.req.valid).toHaveBeenCalledWith('param');
  });

  it('returns whatever the inner function returns when nothing throws', async () => {
    const c = makeContext({ json: { value: 42 } });

    const result = await handler(c, async ({ json }) =>
      c.json({ value: (json as { value: number }).value }, 200),
    );

    expect(result).toEqual({ body: { value: 42 }, status: 200 });
  });

  it('runs the body at most once across the thenable and .errors()', async () => {
    const c = makeContext();
    const body = vi.fn(async () => 'once');
    const invocation = handler(c, body);
    await invocation;
    await invocation;
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('tags the invocation as HandlerInvocation and still behaves as a promise', async () => {
    const c = makeContext();
    const invocation = handler(c, async () => 'value');
    expect(Object.prototype.toString.call(invocation)).toBe('[object HandlerInvocation]');
    expect(await invocation).toBe('value');
    expect(await Promise.resolve(invocation)).toBe('value');
  });
});

describe('handler(...).errors (deprecated)', () => {
  it('composes the error arms via handleErrors and returns a matching arm response', async () => {
    const c = makeContext();

    const result = await handler(c, async () => {
      throw new RecordNotFoundError('missing');
    }).errors([recordNotFoundArm('Not found')]);

    expect(result).toEqual({ body: { message: 'Not found' }, status: 404 });
  });

  it('returns the body result when no arm fires', async () => {
    const c = makeContext({ param: { id: 'x' } });

    const result = await handler(c, async ({ param }) =>
      c.json({ id: (param as { id: string }).id }, 200),
    ).errors([recordNotFoundArm('Not found')]);

    expect(result).toEqual({ body: { id: 'x' }, status: 200 });
  });

  it('reuses the settled body when awaited before .errors()', async () => {
    const c = makeContext();
    const body = vi.fn(async () => 'once');
    const invocation = handler(c, body);
    await invocation;
    const result = await invocation.errors([recordNotFoundArm('Not found')]);
    await invocation.errors([]);
    expect(result).toBe('once');
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('maps a rejection to an arm when .errors() follows an awaited rejection', async () => {
    const c = makeContext();

    const body = vi.fn(async () => {
      throw new RecordNotFoundError('missing');
    });

    const invocation = handler(c, body);
    await expect(invocation).rejects.toBeInstanceOf(RecordNotFoundError);
    const result = await invocation.errors([recordNotFoundArm('Not found')]);
    expect(result).toEqual({ body: { message: 'Not found' }, status: 404 });
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the thrown error matches no arm', async () => {
    const c = makeContext();
    await expect(
      handler(c, async () => {
        throw new Error('boom');
      }).errors([on(RecordNotFoundError, (_err, ec) => ec.json({ message: 'x' }, 404))]),
    ).rejects.toThrow('boom');
  });

  it('thenable form rejects when no arms wired and the body throws', async () => {
    const c = makeContext();
    await expect(
      handler(c, async () => {
        throw new RecordNotFoundError('missing');
      }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});
