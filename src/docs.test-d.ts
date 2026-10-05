// The README examples, inlined as type-level code so `test:types` catches doc drift.
// `pnpm check:docs` requires each README ```ts block to appear here verbatim (after
// normalization). Setup and stubs sit before each block, never inside it. Nothing here runs.
import { expectTypeOf } from 'expect-type';
import { createMiddleware } from 'hono/factory';
import { testClient } from 'hono/testing';
import { z } from 'zod';
import {
  createRouter,
  defineChildContext,
  defineRootContext,
  jsonResponse,
  mountRouter,
} from './index';

// README "Quick start".
const okResponse = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const apiContext = defineRootContext('/api');

const thingsContext = defineChildContext(apiContext, '/things');

const makeRouter = createRouter();

const thingsRouter = makeRouter(thingsContext, ({ app, defineRoute }) => {
  const listThingsRoute = defineRoute('get', { responses: { 200: okResponse } });

  return app.openapi(listThingsRoute, (c) => c.json({ ok: true }, 200));
});

const app = mountRouter(apiContext, [thingsRouter]);

expectTypeOf(thingsContext.path).toEqualTypeOf<'/api/things'>();

expectTypeOf(testClient(app).api.things.$get).toBeFunction();

// README "Quick start": without children, a callback that registers the routes in separate
// statements and returns `app` is a compile error. Returning nothing compiles.
// @ts-expect-error The callback returns an app with no typed routes
makeRouter(thingsContext, ({ app, defineRoute }) => {
  app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
    c.json({ ok: true }, 200),
  );

  return app;
});

makeRouter(thingsContext, ({ app, defineRoute }) => {
  app.openapi(defineRoute('get', { responses: { 200: okResponse } }), (c) =>
    c.json({ ok: true }, 200),
  );
});

// With children, `({ app }) => app` is correct.
expectTypeOf(makeRouter(apiContext, ({ app }) => app, [thingsRouter])).toBeFunction();

// README "Which middleware to use".
{
  const calls: string[] = [];

  const timing = createMiddleware(async function timing(c, next) {
    calls.push('timing');
    const start = Date.now();
    await next();
    c.header('Server-Timing', `total;dur=${Date.now() - start}`);
  });

  const noStore = createMiddleware(async function noStore(c, next) {
    calls.push('noStore');
    await next();
    c.header('Cache-Control', 'no-store');
  });

  interface RequestIdVars {
    requestId: string;
  }

  interface LogVars {
    log: (message: string) => void;
  }

  const apiContext = defineRootContext('/api', [timing, noStore])
    .middleware<RequestIdVars>(async function setRequestId(c, next) {
      calls.push('setRequestId');
      c.set('requestId', c.req.header('x-request-id') ?? 'none');
      await next();
    })
    .middleware<LogVars>(async function setLog(c, next) {
      calls.push('setLog');
      c.set('log', (message) => console.info(`[${c.var.requestId}] ${message}`));
      await next();
    });

  const makeRouter = createRouter({
    routeMiddleware: [
      (route) =>
        async function audit(_c, next) {
          calls.push(`audit:${route.method}`);
          await next();
        },
      () =>
        async function countRequest(_c, next) {
          calls.push('countRequest');
          await next();
        },
    ],
  });

  interface StartVars {
    startedAt: number;
  }

  const markStart = createMiddleware<{ Variables: StartVars }>(async function markStart(c, next) {
    calls.push('markStart');
    c.set('startedAt', Date.now());
    await next();
  });

  const apiRouter = makeRouter(apiContext, ({ app, defineRoute }) => {
    const searchRoute = defineRoute('get', {
      middleware: markStart,
      request: { query: z.object({ q: z.string() }) },
      responses: { 200: jsonResponse(z.object({ q: z.string() }), 'OK') },
    });

    return app.openapi(searchRoute, (c) => {
      calls.push('handler');
      const { q } = c.req.valid('query');
      c.var.log(`search ${q} after ${Date.now() - c.var.startedAt} ms`);

      return c.json({ q }, 200);
    });
  });

  const app = apiRouter();
  await app.request('/api?q=hono');

  expectTypeOf(apiContext.vars).toEqualTypeOf<RequestIdVars & LogVars>();
  expectTypeOf(testClient(app).api.$get).toBeFunction();
}
