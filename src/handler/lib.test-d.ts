import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import type { Context, Input } from 'hono';
import { createRouter } from '../router';
import { defineRootContext } from '../definitions';
import { jsonResponse } from '../factories';
import { handleErrors, on, onError, rethrow } from '../errors';
import { handle, handler } from './lib';
import type { ValidatedProxy } from './types';

const ok = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const conflict = jsonResponse(z.object({ message: z.string() }), 'Conflict');

const ctx = defineRootContext('/api', []);

class ConflictError extends Error {}

// `handle` without arms returns the exact promise type of the body.
{
  const c = {} as Context;
  const ok200 = c.json({ ok: true }, 200);

  expectTypeOf(handle(c, async () => c.json({ ok: true }, 200))).toEqualTypeOf<
    Promise<typeof ok200>
  >();
  expectTypeOf(handle(c, async () => 'x' as const)).toEqualTypeOf<Promise<'x'>>();
}

// `handle` with arms adds the response of each arm to the result. An arm that only rethrows
// adds nothing.
{
  const c = {} as Context;

  class MissingError extends Error {}

  const ok200 = c.json({ ok: true }, 200);
  const notFound404 = c.json({ message: 'nf' }, 404);
  const conflict409 = c.json({ message: 'x' }, 409);

  type Ok = typeof ok200;

  type NotFound = typeof notFound404;

  type Conflict = typeof conflict409;

  async function body() {
    return c.json({ ok: true }, 200);
  }

  const notFoundArm = onError(MissingError, (_e, ec) => ec.json({ message: 'nf' }, 404));
  const conflictArm = onError(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409));
  const asyncArm = onError(MissingError, async (_e, ec) => ec.json({ message: 'nf' }, 404));

  expectTypeOf(handle(c, body, [notFoundArm])).toEqualTypeOf<Promise<Ok | NotFound>>();
  expectTypeOf(handle(c, body, [notFoundArm, conflictArm])).toEqualTypeOf<
    Promise<Ok | NotFound | Conflict>
  >();
  expectTypeOf(handle(c, body, [asyncArm])).toEqualTypeOf<Promise<Ok | NotFound>>();
  expectTypeOf(handle(c, body, [onError(ConflictError, () => rethrow())])).toEqualTypeOf<
    Promise<Ok>
  >();
  expectTypeOf(handle(c, body, [onError(ConflictError, async () => rethrow())])).toEqualTypeOf<
    Promise<Ok>
  >();
  expectTypeOf(handle(c, body, [])).toEqualTypeOf<Promise<Ok>>();
}

// In `router.openapi`, the route types the proxy, and an arm with a declared status compiles.
createRouter()(defineRootContext('/api/:id', []), ({ app, defineRoute }) => {
  const declared = defineRoute('post', {
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: ok, 409: conflict },
  });

  app.openapi(declared, (c) =>
    handle(
      c,
      async ({ param }) => {
        expectTypeOf(param.id).toEqualTypeOf<string>();

        return c.json({ ok: true }, 200);
      },
      [onError(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409))],
    ),
  );
  app.openapi(declared, (c) => handle(c, async () => c.json({ ok: true }, 200)));
});

// The proxy has only the targets that the route declares.
createRouter()(ctx, ({ app, defineRoute }) =>
  app.openapi(defineRoute('post', { responses: { 200: ok } }), (c) =>
    handle(c, async (proxy) => {
      expectTypeOf(proxy).toEqualTypeOf<ValidatedProxy<{}>>();
      // @ts-expect-error Property 'json' does not exist on type 'ValidatedProxy<{}>'
      void proxy.json;

      return c.json({ ok: true }, 200);
    }),
  ),
);

// A path with params always has `param`, typed from the path.
createRouter()(defineRootContext('/api/:id', []), ({ app, defineRoute }) =>
  app.openapi(defineRoute('post', { responses: { 200: ok } }), (c) =>
    handle(c, async ({ param, ...rest }) => {
      expectTypeOf(param).toEqualTypeOf<{ id: string }>();
      expectTypeOf(rest).toEqualTypeOf<{}>();

      return c.json({ ok: true }, 200);
    }),
  ),
);

// A `Context` typed with the general `Input` keeps every target.
{
  const c = {} as Context<any, any, Input>;

  void handle(c, async ({ json, param, query }) => [json, param, query]);
}

// An arm response that the route does not declare is a compile error.
createRouter()(ctx, ({ app, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok } });
  app.openapi(declared, (c) =>
    // @ts-expect-error the 409 arm response is not in `responses`
    handle(c, async () => c.json({ ok: true }, 200), [
      onError(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]),
  );
});

// An async arm that only rethrows adds nothing to the response type.
createRouter()(ctx, ({ app, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok } });
  app.openapi(declared, (c) =>
    handle(c, async () => c.json({ ok: true }, 200), [
      onError(ConflictError, async () => rethrow()),
    ]),
  );
});

// A body that returns an undeclared status is a compile error.
createRouter()(ctx, ({ app, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok } });
  app.openapi(declared, (c) =>
    // @ts-expect-error 500 is not in `responses`
    handle(c, async () => c.json({ ok: true }, 500)),
  );
});

// The deprecated `handler(c, fn).errors([...])` and `on` type as `handle` does.
{
  const c = {} as Context;
  const ok200 = c.json({ ok: true }, 200);
  const conflict409 = c.json({ message: 'x' }, 409);

  function run() {
    return handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]);
  }

  type R = Awaited<ReturnType<typeof run>>;

  expectTypeOf<R>().toEqualTypeOf<typeof ok200 | typeof conflict409>();
}

// An arm that only rethrows adds no response.
{
  const c = {} as Context;

  function noArms() {
    return handler(c, async () => c.json({ ok: true }, 200)).errors([]);
  }

  type NoArms = Awaited<ReturnType<typeof noArms>>;

  function run() {
    return handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, () => rethrow()),
    ]);
  }

  type R = Awaited<ReturnType<typeof run>>;

  expectTypeOf<R>().toEqualTypeOf<NoArms>();
}

// `handleErrors` and `.errors([...])` give the same type.
{
  const c = {} as Context;

  class MissingError extends Error {}

  const ok200 = c.json({ ok: true }, 200);
  const notFound404 = c.json({ message: 'nf' }, 404);
  const conflict409 = c.json({ message: 'x' }, 409);

  type Ok = typeof ok200;

  type NotFound = typeof notFound404;

  type Conflict = typeof conflict409;

  async function body() {
    return c.json({ ok: true }, 200);
  }

  const notFoundArm = on(MissingError, (_e, ec) => ec.json({ message: 'nf' }, 404));
  const conflictArm = on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409));
  const rethrowArm = on(ConflictError, () => rethrow());
  const asyncArm = on(MissingError, async (_e, ec) => ec.json({ message: 'nf' }, 404));

  expectTypeOf(handler(c, body).errors([notFoundArm])).toEqualTypeOf<Promise<Ok | NotFound>>();
  expectTypeOf(handleErrors(body, [notFoundArm], c)).toEqualTypeOf<Promise<Ok | NotFound>>();
  expectTypeOf(handler(c, body).errors([notFoundArm, conflictArm])).toEqualTypeOf<
    Promise<Ok | NotFound | Conflict>
  >();
  expectTypeOf(handleErrors(body, [notFoundArm, conflictArm], c)).toEqualTypeOf<
    Promise<Ok | NotFound | Conflict>
  >();
  expectTypeOf(handler(c, body).errors([rethrowArm])).toEqualTypeOf<Promise<Ok>>();
  expectTypeOf(handleErrors(body, [rethrowArm], c)).toEqualTypeOf<Promise<Ok>>();
  expectTypeOf(handler(c, body).errors([asyncArm])).toEqualTypeOf<Promise<Ok | NotFound>>();
  expectTypeOf(handleErrors(body, [asyncArm], c)).toEqualTypeOf<Promise<Ok | NotFound>>();
}

// An arm response that the route declares compiles.
createRouter()(ctx, ({ app, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok, 409: conflict } });
  app.openapi(declared, (c) =>
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]),
  );
});

// An arm response that the route does not declare is a compile error.
createRouter()(ctx, ({ app, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok } });
  app.openapi(declared, (c) =>
    // @ts-expect-error the 409 arm response is not in `responses`
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]),
  );
});

// An async arm that only rethrows adds nothing to the response type, not even `symbol`.
createRouter()(ctx, ({ app, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok } });
  app.openapi(declared, (c) =>
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, async () => rethrow()),
    ]),
  );
});

// A body that returns an undeclared status is a compile error.
createRouter()(ctx, ({ app, defineRoute }) => {
  const declared = defineRoute('post', { responses: { 200: ok } });
  app.openapi(declared, (c) =>
    // @ts-expect-error 500 is not in `responses`
    handler(c, async () => c.json({ ok: true }, 500)),
  );
});
