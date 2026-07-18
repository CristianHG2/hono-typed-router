import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import type { Context } from 'hono';
import { createRouter } from '../router';
import { defineRootRoute } from '../definitions';
import { makeHonoResponse } from '../factories';
import { on, rethrow } from '../errors';
import { handler } from './lib';

const ok = makeHonoResponse(z.object({ ok: z.boolean() }), 'OK');
const conflict = makeHonoResponse(z.object({ message: z.string() }), 'Conflict');
const ctx = defineRootRoute('/api', []);

class ConflictError extends Error {}

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
    handler(c, async () => c.json({ ok: true }, 200)).errors([
      on(ConflictError, () => rethrow()),
    ]);
  type R = Awaited<ReturnType<typeof run>>;
  expectTypeOf<R>().toEqualTypeOf<NoArms>();
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

// The body returning an undeclared status is likewise a compile error.
createRouter()(ctx, ({ router, route }) => {
  const declared = route('post', { responses: { 200: ok } });
  router.openapi(declared, (c) =>
    // @ts-expect-error — 500 is absent from `responses`
    handler(c, async () => c.json({ ok: true }, 500)),
  );
  return router;
});
