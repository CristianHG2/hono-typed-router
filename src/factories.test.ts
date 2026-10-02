import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRootRoute } from './definitions';
import { makeHonoJsonRequest, makeHonoResponse } from './factories';
import { createRouter } from './router';

const Body = z.object({ name: z.string() });

const buildApp = () =>
  createRouter()(defineRootRoute('/api', []), ({ router, route }) => {
    const r = route('post', {
      request: makeHonoJsonRequest(Body, 'Create'),
      responses: { 200: makeHonoResponse(z.object({ got: z.unknown() }), 'OK') },
    });

    router.openapi(r as never, (c) => c.json({ got: c.req.valid('json' as never) }) as never);

    return router;
  })();

describe('makeHonoJsonRequest', () => {
  it('marks the body as required', () => {
    expect(makeHonoJsonRequest(Body, 'Create').body.required).toBe(true);
  });

  it('rejects a POST without a body with 400', async () => {
    const res = await buildApp().request('/api', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('accepts a valid JSON body', async () => {
    const res = await buildApp().request('/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { name: 'x' } });
  });
});
