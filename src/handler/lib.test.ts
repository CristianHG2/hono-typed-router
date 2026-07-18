import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { on } from '../errors';
import { handler } from './lib';

type FakeContext = Context & {
  req: { valid: ReturnType<typeof vi.fn> };
  json: ReturnType<typeof vi.fn>;
};

const makeContext = (validated: Record<string, unknown> = {}): FakeContext => {
  const valid = vi.fn((target: string) => validated[target]);
  const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
  return {
    req: { valid },
    json,
  } as unknown as FakeContext;
};

class RecordNotFoundError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'RecordNotFoundError';
  }
}

const recordNotFoundArm = (message: string) =>
  on(RecordNotFoundError, (_err, c) => c.json({ message }, 404));

describe('handler', () => {
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
});

describe('handler.errors', () => {
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

  it('rethrows when the thrown error matches no arm', async () => {
    const c = makeContext();
    await expect(
      handler(c, async () => {
        throw new Error('boom');
      }).errors([recordNotFoundArm('Not found')]),
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
