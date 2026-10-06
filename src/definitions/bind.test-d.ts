import { expectTypeOf } from 'expect-type';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { createRouter } from '../router';
import type { BindParam } from './bind';
import { extendRouteContext } from './extend';
import type { ReaugmentContext, RouteContextBase, RouteContextKind } from './extend';
import { defineChildContext, defineRootContext } from './lib';
import type { RouteContext } from './types';

type Session = { userId: string };

type Organization = { id: string; name: string };

type Team = { id: string };

declare const findOrganization: (id: string, userId: string) => Promise<Organization | null>;

declare const findTeam: (id: string) => Team | undefined;

const authed = defineRootContext('/api').middleware<{ session: Session }>(async (_c, next) => {
  await next();
});

// One bind adds the var with the value type of the loader, without `null` and the promise.
{
  const ctx = defineChildContext(authed, '/organizations/:organizationId').bind(
    'organization',
    'organizationId',
    (id, c) => findOrganization(id, c.var.session.userId),
  );

  expectTypeOf(ctx.path).toEqualTypeOf<'/api/organizations/:organizationId'>();
  expectTypeOf(ctx.vars).toEqualTypeOf<{ session: Session } & { organization: Organization }>();
  expectTypeOf(ctx).toMatchTypeOf<
    RouteContext<'/api/organizations/:organizationId', { organization: Organization }>
  >();
}

// The loader gets the param value as a string and `c` with the vars of the context.
{
  defineChildContext(authed, '/organizations/:organizationId').bind(
    'organization',
    'organizationId',
    (id, c) => {
      expectTypeOf(id).toEqualTypeOf<string>();
      expectTypeOf(c.var.session).toEqualTypeOf<Session>();
      // @ts-expect-error the context has no `team` var
      void c.var.team;

      return findOrganization(id, c.var.session.userId);
    },
  );
}

// Two binds and a `.middleware()` after them: each step sees the vars before it.
{
  const ctx = defineChildContext(authed, '/organizations/:organizationId/teams/:teamId')
    .bind('organization', 'organizationId', (id, c) => findOrganization(id, c.var.session.userId))
    .bind('team', 'teamId', (id, c) => {
      expectTypeOf(c.var.organization).toEqualTypeOf<Organization>();

      return findTeam(id);
    })
    .middleware<{ membership: string }>(async (c, next) => {
      expectTypeOf(c.var.organization).toEqualTypeOf<Organization>();
      expectTypeOf(c.var.team).toEqualTypeOf<Team>();
      c.set('membership', `${c.var.organization.id}:${c.var.team.id}`);
      await next();
    });

  expectTypeOf(ctx.vars.organization).toEqualTypeOf<Organization>();
  expectTypeOf(ctx.vars.team).toEqualTypeOf<Team>();
  expectTypeOf(ctx.vars.membership).toEqualTypeOf<string>();
}

// A key that the context already has gives the redeclaration message.
{
  const ctx = defineRootContext('/api/:id').bind('thing', 'id', (id) => id);

  // @ts-expect-error 'thing' is already a var
  ctx.bind('thing', 'id', (id) => id);
  // @ts-expect-error 'session' is already a var of `authed`
  defineChildContext(authed, '/:id').bind('session', 'id', (id) => id);

  // The key parameter of `.bind()` on a context that has `thing` is the error message.
  type KeyParam = Parameters<typeof ctx.bind<'thing', string>>[0];

  expectTypeOf<KeyParam>().toEqualTypeOf<'Cannot redeclare existing var: thing. Use another var name, or read thing from the context.'>();
}

// The key must be one string literal, because `.bind()` sets one var. The union check does
// not distribute, so a union gives one message.
declare const stringKey: string;

declare const unionKey: 'a' | 'b';

{
  const ctx = defineRootContext('/api/:id');

  // @ts-expect-error a `string` key does not name one var
  ctx.bind(stringKey, 'id', (id) => id);
  // @ts-expect-error a union key names two vars, and the loader sets one
  ctx.bind(unionKey, 'id', (id) => id);

  expectTypeOf<
    Parameters<typeof ctx.bind<string, string>>[0]
  >().toEqualTypeOf<'Use a string literal for the key'>();
  expectTypeOf<
    Parameters<typeof ctx.bind<'a' | 'b', string>>[0]
  >().toEqualTypeOf<'Use one string literal for the key'>();
  expectTypeOf<Parameters<typeof ctx.bind<'a', string>>[0]>().toEqualTypeOf<'a'>();

  const bound = ctx.bind('a', 'id', (id) => id);

  expectTypeOf(bound.vars).toEqualTypeOf<{} & { a: string }>();
}

// An annotation on `c`, or an explicit third type argument, lets the loader read vars that the
// context does not have. The key check uses the vars of the context.
{
  type OtherVars = { session: Session; other: number };

  const withId = defineChildContext(authed, '/:id');

  const annotated = withId.bind(
    'x',
    'id',
    (_id: string, c: Context<{ Variables: OtherVars }>) => c.var.other,
  );

  expectTypeOf(annotated.vars.x).toEqualTypeOf<number>();

  const explicit = withId.bind<'y', number, OtherVars>('y', 'id', (_id, c) => c.var.other);

  expectTypeOf(explicit.vars.y).toEqualTypeOf<number>();

  // @ts-expect-error 'session' is already a var, with an annotation on `c`
  withId.bind('session', 'id', (_id: string, _c: Context<{ Variables: OtherVars }>) => 1);
  // @ts-expect-error 'session' is already a var, with an explicit third type argument
  withId.bind<'session', number, OtherVars>('session', 'id', () => 1);
}

// A context with a widened `string` path has no params, so `.bind()` cannot be called.
{
  expectTypeOf<BindParam<string>>().toBeNever();

  const wide = defineRootContext('/api/:id' as string);

  // @ts-expect-error `BindParam<string>` is `never`
  wide.bind('x', 'id', (id) => id);
}

// `param` must be a required param of the context path.
{
  const ctx = defineRootContext('/api/:id/:slug?');

  // @ts-expect-error 'nope' is not a param of the path
  ctx.bind('thing', 'nope', (id) => id);
  // @ts-expect-error an optional param is not accepted
  ctx.bind('thing', 'slug?', (id) => id);
  // @ts-expect-error an optional param is not accepted without its `?` either
  ctx.bind('thing', 'slug', (id) => id);
  ctx.bind('thing', 'id', (id) => id);
}

// A sync loader: the var has the return type of the loader.
{
  const ctx = defineRootContext('/api/:id').bind('count', 'id', (id) => Number(id));
  expectTypeOf(ctx.vars).toEqualTypeOf<{} & { count: number }>();
}

// A loader with a bare `Context` annotation on `c` adds a new key.
{
  const ctx = defineRootContext('/api/:id').bind('thing', 'id', (id: string, _c: Context) => id);

  expectTypeOf(ctx.vars.thing).toEqualTypeOf<string>();
}

// The curried child form: the param comes from the full path.
{
  const child = defineChildContext<typeof authed>()('/organizations/:organizationId').bind(
    'organization',
    'organizationId',
    (id, c) => findOrganization(id, c.var.session.userId),
  );

  expectTypeOf(child.path).toEqualTypeOf<'/api/organizations/:organizationId'>();
  expectTypeOf(child.vars.organization).toEqualTypeOf<Organization>();
}

// The root fold: the loader sees the vars of all the middlewares of the array.
{
  const withSession = createMiddleware<{ Variables: { session: Session } }>(async (_c, next) => {
    await next();
  });

  const withRequestId = createMiddleware<{ Variables: { requestId: string } }>(async (_c, next) => {
    await next();
  });

  const ctx = defineRootContext('/orgs/:organizationId', [withSession, withRequestId]).bind(
    'organization',
    'organizationId',
    (id, c) => {
      expectTypeOf(c.var.requestId).toEqualTypeOf<string>();

      return findOrganization(id, c.var.session.userId);
    },
  );

  expectTypeOf(ctx.vars.organization).toEqualTypeOf<Organization>();
  expectTypeOf(ctx.vars.requestId).toEqualTypeOf<string>();
}

// A bound context is assignable to a context with fewer vars, and `makeRouter` accepts it.
// Route handlers read the bound var.
{
  const ctx = defineChildContext(authed, '/organizations/:organizationId').bind(
    'organization',
    'organizationId',
    (id, c) => findOrganization(id, c.var.session.userId),
  );

  expectTypeOf(ctx).toMatchTypeOf<RouteContext<string, object>>();

  createRouter()(ctx, ({ app, defineRoute }) => {
    app.openapi(defineRoute('get', { responses: { 204: { description: 'No content' } } }), (c) => {
      expectTypeOf(c.var.organization).toEqualTypeOf<Organization>();

      return c.body(null, 204);
    });
  });
}

// An extended context keeps its builders after `.bind()`, and `.bind()` after a builder
// sees the vars of the builder.
interface Ctx<TPath extends string, TVars extends object> extends RouteContextBase<
  CtxKind,
  TPath,
  TVars
> {
  withFlag: () => ReaugmentContext<CtxKind, TPath, TVars & { flag: boolean }>;
}

interface CtxKind extends RouteContextKind {
  type: Ctx<this['path'] & string, this['vars'] & object>;
}

{
  const extended = extendRouteContext<CtxKind>({
    withFlag: (ctx) => () => ctx.middleware(async (_c, next) => next()),
  });

  const ctx = extended
    .defineRootContext('/orgs/:organizationId')
    .bind('organization', 'organizationId', (id) => findOrganization(id, 'u'))
    .withFlag()
    .bind('team', 'organizationId', (id, c) => {
      expectTypeOf(c.var.flag).toEqualTypeOf<boolean>();
      expectTypeOf(c.var.organization).toEqualTypeOf<Organization>();

      return findTeam(id);
    });

  expectTypeOf(ctx.withFlag).toBeFunction();
  expectTypeOf(ctx.vars.team).toEqualTypeOf<Team>();
  expectTypeOf(ctx.path).toEqualTypeOf<'/orgs/:organizationId'>();
  // The extended root gives `object` vars (the kind evaluates `{} & object`).
  expectTypeOf(ctx.vars).toEqualTypeOf<
    object & { organization: Organization } & { flag: boolean } & { team: Team }
  >();

  // @ts-expect-error 'flag' is already a var
  ctx.bind('flag', 'organizationId', () => true);
  // @ts-expect-error The loader returns no value. The check also runs on an extended context
  ctx.bind('empty', 'organizationId', async () => null);

  const child = extended
    .defineChildContext<typeof ctx>()('/members/:memberId')
    .bind('member', 'memberId', (id) => ({ id }));

  expectTypeOf(child.withFlag).toBeFunction();
  expectTypeOf(child.vars.member).toEqualTypeOf<{ id: string }>();
}
