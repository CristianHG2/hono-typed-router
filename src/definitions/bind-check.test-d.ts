import { expectTypeOf } from 'expect-type';
import type { Context } from 'hono';
import type { BindLoader } from './bind';
import { defineChildContext, defineRootContext } from './lib';

type Session = { userId: string };

type Thing = { id: string };

type Vars = { session: Session };

declare const findThing: (id: string) => Promise<Thing | null>;

declare const voidPromise: () => Promise<void>;

declare const nullOrUndefined: () => null | undefined;

declare const nullPromiseOrUndefined: () => Promise<null> | undefined;

declare const unknownLoader: () => unknown;

const authed = defineRootContext('/api').middleware<Vars>(async (_c, next) => {
  await next();
});

const ctx = defineChildContext(authed, '/things/:id');

// A loader that can return no value is an error: only `null`, `undefined`, `void`, `never`, or
// a promise of one of these.
{
  // @ts-expect-error — The loader returns no value (`void`)
  ctx.bind('x', 'id', () => {});
  // @ts-expect-error — The loader returns no value (`never`)
  ctx.bind('x', 'id', () => {
    throw new Error('x');
  });
  // @ts-expect-error — The loader returns no value (`Promise<null>`)
  ctx.bind('x', 'id', async () => null);
  // @ts-expect-error — The loader returns no value (`undefined`)
  ctx.bind('x', 'id', () => undefined);
  // @ts-expect-error — The loader returns no value (`null`)
  ctx.bind('x', 'id', () => null);
  // @ts-expect-error — The loader returns no value (`Promise<void>`)
  ctx.bind('x', 'id', async () => {});
  // @ts-expect-error — The loader returns no value (a declared `Promise<void>`)
  ctx.bind('x', 'id', voidPromise);
  // @ts-expect-error — The loader returns no value (`null | undefined`)
  ctx.bind('x', 'id', nullOrUndefined);
  // @ts-expect-error — The loader returns no value (`Promise<null> | undefined`)
  ctx.bind('x', 'id', nullPromiseOrUndefined);
  // @ts-expect-error — The loader returns no value (`Promise<never>`)
  ctx.bind('x', 'id', async () => {
    throw new Error('x');
  });
  // @ts-expect-error — The loader returns no value (reads `c.var`, returns nothing)
  ctx.bind('x', 'id', (_id, c) => {
    void c.var.session;
  });
}

// The parameter type of `load` is the error message.
{
  type LoadParam = Parameters<typeof ctx.bind<'x', null>>[2];

  expectTypeOf<
    LoadParam extends 'The loader returns no value: return the value of the var, or null when there is none'
      ? true
      : false
  >().toEqualTypeOf<true>();
}

// The key error wins over the loader error.
{
  // @ts-expect-error — Cannot redeclare existing var: session
  ctx.bind('session', 'id', () => null);

  type KeyParam = Parameters<typeof ctx.bind<'session', null>>[0];

  expectTypeOf<KeyParam>().toEqualTypeOf<'Cannot redeclare existing var: session'>();
}

// A loader that can return a value compiles.
{
  expectTypeOf(ctx.bind('x', 'id', (id) => JSON.parse(id)).vars.x).toBeAny();
  expectTypeOf(ctx.bind('x', 'id', (id): any => id).vars.x).toBeAny();
  expectTypeOf(ctx.bind('x', 'id', unknownLoader).vars.x).toEqualTypeOf<{}>();
  expectTypeOf(ctx.bind('x', 'id', (id): Thing | null => ({ id })).vars).toEqualTypeOf<
    Vars & { x: Thing }
  >();
  expectTypeOf(
    ctx.bind('x', 'id', async (id): Promise<Thing | undefined> => ({ id })).vars,
  ).toEqualTypeOf<Vars & { x: Thing }>();
  expectTypeOf(ctx.bind('x', 'id', (id) => ({ id })).vars).toEqualTypeOf<
    Vars & { x: { id: string } }
  >();
  expectTypeOf(ctx.bind('x', 'id', (id) => id).vars).toEqualTypeOf<Vars & { x: string }>();
  expectTypeOf(
    ctx.bind('x', 'id', (id, c) => findThing(id + c.var.session.userId)).vars,
  ).toEqualTypeOf<Vars & { x: Thing }>();
  expectTypeOf(
    ctx.bind<'x', number, Vars & { other: number }>('x', 'id', (_id, c) => c.var.other).vars,
  ).toEqualTypeOf<Vars & { x: number }>();
  expectTypeOf(ctx.bind('x', 'id', (id: string, _c: Context) => id).vars).toEqualTypeOf<
    Vars & { x: string }
  >();
}

// These cases guard the wildcard behaviour that the check relies on (see the JSDoc of
// `BindLoadedKind`): a loader whose return type is a type parameter is accepted. A TypeScript
// upgrade that changes this behaviour fails here first.
{
  const viaFind = <T>(find: (id: string) => Promise<T | null>) =>
    ctx.bind('x', 'id', (id) => find(id));

  const viaLoader = <TValue>(load: BindLoader<Vars, TValue>) => ctx.bind('x', 'id', load);

  const viaObject = <T extends object>(get: (id: string) => T | undefined) =>
    ctx.bind('x', 'id', (id) => get(id));

  const viaUndefined = <T>(find: (id: string) => Promise<T | undefined>) =>
    ctx.bind('x', 'id', (id) => find(id));

  const viaPlain = <T>(get: (id: string) => T) => ctx.bind('x', 'id', (id) => get(id));

  expectTypeOf(viaFind(findThing).vars).toEqualTypeOf<Vars & { x: Thing }>();
  expectTypeOf(viaLoader(findThing).vars).toEqualTypeOf<Vars & { x: Thing }>();
  expectTypeOf(viaObject((id) => ({ id })).vars).toEqualTypeOf<Vars & { x: { id: string } }>();
  expectTypeOf(viaUndefined(findThing).vars).toEqualTypeOf<Vars & { x: Thing }>();
  expectTypeOf(viaPlain((id) => id).vars).toEqualTypeOf<Vars & { x: string }>();

  // Limit: the check does not run through a generic wrapper. A wrapper call with a loader that
  // returns only `null` compiles.
  viaPlain(() => null);
}
