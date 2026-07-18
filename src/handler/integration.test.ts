import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Context } from 'hono';
import { defineRootRoute } from '../definitions';
import { makeHonoResponse } from '../factories';
import { createRouter } from '../router';
import { on } from '../errors';
import { handler } from './lib';

const okResponse = makeHonoResponse(z.object({ id: z.string() }), 'OK');
const notFound = makeHonoResponse(z.object({ message: z.string() }), 'Not found');

class RecordNotFoundError extends Error {}

const buildRouter = (shouldThrow: boolean) => {
  const ctx = defineRootRoute('/api', []);
  return createRouter()(ctx, ({ router, route }) => {
    const r = route('get', { responses: { 200: okResponse, 404: notFound } });
    router.openapi(
      r as never,
      ((c: Context) =>
        handler(c, async () => {
          if (shouldThrow) {
            throw new RecordNotFoundError('missing');
          }
          return c.json({ id: 'thing-1' }, 200);
        }).errors([
          on(RecordNotFoundError, (_e, ec) => ec.json({ message: 'Not found' }, 404)),
        ])) as never,
    );
    return router;
  })();
};

describe('handler + errors end-to-end', () => {
  it('returns the body response when nothing throws', async () => {
    const res = await buildRouter(false).request('/api');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'thing-1' });
  });

  it('dispatches a thrown error to its arm and returns that response', async () => {
    const res = await buildRouter(true).request('/api');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Not found' });
  });
});
