import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRootRoute } from './definitions';
import {
  emptyResponse,
  jsonBody,
  jsonRequest,
  jsonResponse,
  makeHonoJsonBody,
  makeHonoJsonRequest,
  makeHonoNoContentResponse,
  makeHonoResponse,
} from './factories';
import { createRouter } from './router';

const Body = z.object({ name: z.string() });

const buildApp = () =>
  createRouter()(defineRootRoute('/api', []), ({ router, route }) => {
    const r = route('post', {
      request: jsonRequest(Body, 'Create'),
      responses: { 200: jsonResponse(z.object({ got: z.unknown() }), 'OK') },
    });

    router.openapi(r as never, (c) => c.json({ got: c.req.valid('json' as never) }) as never);

    return router;
  })();

describe('jsonRequest', () => {
  it('marks the body as required', () => {
    expect(jsonRequest(Body, 'Create').body.required).toBe(true);
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

describe('response and body factories', () => {
  it('builds a JSON response and body with the same shape', () => {
    const expected = { description: 'OK', content: { 'application/json': { schema: Body } } };

    expect(jsonResponse(Body, 'OK')).toEqual(expected);
    expect(jsonBody(Body, 'OK')).toEqual(expected);
  });

  it('builds an empty response', () => {
    expect(emptyResponse('Deleted')).toEqual({ description: 'Deleted' });
  });

  it('keeps the 0.x names as aliases', () => {
    expect(makeHonoResponse).toBe(jsonResponse);
    expect(makeHonoJsonBody).toBe(jsonBody);
    expect(makeHonoJsonRequest).toBe(jsonRequest);
    expect(makeHonoNoContentResponse).toBe(emptyResponse);
  });
});
