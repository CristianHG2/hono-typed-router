import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import type { Context } from 'hono';
import { createRouter } from '../router';
import { defineRootRoute } from '../definitions';
import { jsonResponse } from '../factories';
import { handleErrors, on, onError, rethrow } from '../errors';
import { handle, handler } from './lib';

const ok = jsonResponse(z.object({ ok: z.boolean() }), 'OK');

const conflict = jsonResponse(z.object({ message: z.string() }), 'Conflict');

const ctx = defineRootRoute('/api', []);

class ConflictError extends Error {}

// `handle` without arms returns exactly the body's promise type.
{
  const c = {} as Context;
  const ok200 = c.json({ ok: true }, 200);

  expectTypeOf(handle(c, async () => c.json({ ok: true }, 200))).toEqualTypeOf<
    Promise<typeof ok200>
  >();
  expectTypeOf(handle(c, async () => 'x' as const)).toEqualTypeOf<Promise<'x'>>();
}

// `handle` with arms widens the result with each arm's response; a rethrow-only arm
// (sync or async) adds nothing.
{
  const c = {} as Context;

  class MissingError extends Error {}

  const ok200 = c.json({ ok: true }, 200);
  const notFound404 = c.json({ message: 'nf' }, 404);
  const conflict409 = c.json({ message: 'x' }, 409);

  type Ok = typeof ok200;

  type NotFound = typeof notFound404;

  type Conflict = typeof conflict409;

  const body = async () => c.json({ ok: true }, 200);
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

// Inside `router.openapi`: the proxy is typed from the route, and a declared arm status
// type-checks.
createRouter()(defineRootRoute('/api/:id', []), ({ router, route }) => {
  const declared = route('post', {
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: ok, 409: conflict },
  });

  router.openapi(declared, (c) =>
    handle(
      c,
      async ({ param }) => {
        expectTypeOf(param.id).toEqualTypeOf<string>();

        return c.json({ ok: true }, 200);
      },
      [onError(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409))],
    ),
  );
  router.openapi(declared, (c) => handle(c, async () => c.json({ ok: true }, 200)));

  return router;
});

// An arm response the route does NOT declare is a compile error.
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok } });
  router.openapi(declared, (c) =>
    // @ts-expect-error — the 409 arm response is absent from `responses`
    handle(c, async () => c.json({ ok: true }, 200), [
      onError(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]),
  );

  return router;
});

// An async arm that only rethrows adds nothing to the response type.
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok } });
  router.openapi(declared, (c) =>
    handle(c, async () => c.json({ ok: true }, 200), [
      onError(ConflictError, async () => rethrow()),
    ]),
  );

  return router;
});

// The body returning an undeclared status is a compile error.
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok } });
  router.openapi(declared, (c) =>
    // @ts-expect-error — 500 is absent from `responses`
    handle(c, async () => c.json({ ok: true }, 500)),
  );

  return router;
});

// Deprecated `handler(c, fn).errors([...])` and `on`: same typing as above.
// `.errors([...])` widens the awaited result with each arm's response type.
{
  const c = {} as Context;
  const ok200 = c.json({ ok: true }, 200);
  const conflict409 = c.json({ message: 'x' }, 409);

  const run = () =>
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]);

  type R = Awaited<ReturnType<typeof run>>;

  expectTypeOf<R>().toEqualTypeOf<typeof ok200 | typeof conflict409>();
}

// An arm that only ever rethrows contributes no response to the union: the
// result matches wiring no arms at all (the union test above shows an active
// arm would otherwise add its 409).
{
  const c = {} as Context;
  const noArms = () => handler(c, async () => c.json({ ok: true }, 200)).errors([]);

  type NoArms = Awaited<ReturnType<typeof noArms>>;

  const run = () =>
    handler(c, async () => c.json({ ok: true }, 200)).errors([on(ConflictError, () => rethrow())]);

  type R = Awaited<ReturnType<typeof run>>;

  expectTypeOf<R>().toEqualTypeOf<NoArms>();
}

// `handleErrors` and `.errors([...])` share one arm extractor (`ArmsResponse` in
// errors/lib): both resolve to `TBody | <each arm's awaited response, minus Rethrow>`
// for one arm, two arms, a rethrow-only arm, and an async arm.
{
  const c = {} as Context;

  class MissingError extends Error {}

  const ok200 = c.json({ ok: true }, 200);
  const notFound404 = c.json({ message: 'nf' }, 404);
  const conflict409 = c.json({ message: 'x' }, 409);

  type Ok = typeof ok200;

  type NotFound = typeof notFound404;

  type Conflict = typeof conflict409;

  const body = async () => c.json({ ok: true }, 200);
  const notFoundArm = on(MissingError, (_e, ec) => ec.json({ message: 'nf' }, 404));
  const conflictArm = on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409));
  const rethrowArm = on(ConflictError, () => rethrow());
  const asyncArm = on(MissingError, async (_e, ec) => ec.json({ message: 'nf' }, 404));

  // (a) one arm returning 404
  expectTypeOf(handler(c, body).errors([notFoundArm])).toEqualTypeOf<Promise<Ok | NotFound>>();
  expectTypeOf(handleErrors(body, [notFoundArm], c)).toEqualTypeOf<Promise<Ok | NotFound>>();
  // (b) two arms 404 | 409
  expectTypeOf(handler(c, body).errors([notFoundArm, conflictArm])).toEqualTypeOf<
    Promise<Ok | NotFound | Conflict>
  >();
  expectTypeOf(handleErrors(body, [notFoundArm, conflictArm], c)).toEqualTypeOf<
    Promise<Ok | NotFound | Conflict>
  >();
  // (c) rethrow-only arm adds nothing
  expectTypeOf(handler(c, body).errors([rethrowArm])).toEqualTypeOf<Promise<Ok>>();
  expectTypeOf(handleErrors(body, [rethrowArm], c)).toEqualTypeOf<Promise<Ok>>();
  // (d) async arm contributes its awaited response
  expectTypeOf(handler(c, body).errors([asyncArm])).toEqualTypeOf<Promise<Ok | NotFound>>();
  expectTypeOf(handleErrors(body, [asyncArm], c)).toEqualTypeOf<Promise<Ok | NotFound>>();
}

// A response an arm can emit that IS declared on the route type-checks.
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok, 409: conflict } });
  router.openapi(declared, (c) =>
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]),
  );

  return router;
});

// A response an arm can emit that the route does NOT declare is a compile error.
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok } });
  router.openapi(declared, (c) =>
    // @ts-expect-error — the 409 arm response is absent from `responses`
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, (_e, ec) => ec.json({ message: 'x' }, 409)),
    ]),
  );

  return router;
});

// An async arm that only rethrows adds nothing to the response type (no `symbol` leak).
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok } });
  router.openapi(declared, (c) =>
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, async () => rethrow()),
    ]),
  );

  return router;
});

// The body returning an undeclared status is likewise a compile error.
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok } });
  router.openapi(declared, (c) =>
    // @ts-expect-error — 500 is absent from `responses`
    handler(c, async () => c.json({ ok: true }, 500)),
  );

  return router;
});
