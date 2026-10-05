import { describe, expect, it } from 'vitest';
import { extendRouteContext } from './extend';
import type { RouteContextBase, RouteContextKind } from './extend';
import { defineChildContext, defineRootContext } from './lib';

interface PlainContext<TPath extends string, TVars extends object> extends RouteContextBase<
  PlainContextKind,
  TPath,
  TVars
> {}

interface PlainContextKind extends RouteContextKind {
  type: PlainContext<this['path'] & string, this['vars'] & object>;
}

const extended = extendRouteContext<PlainContextKind>({});

describe('context path syntax', () => {
  it('throws when a root path uses OpenAPI {param} syntax', () => {
    expect(() => defineRootContext('/api/{id}')).toThrow(TypeError);
    expect(() => defineRootContext('/api/{id}')).toThrow(
      new TypeError(
        "hono-typed-router: defineRootContext: the path '/api/{id}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/api/:id'.",
      ),
    );
  });

  it('throws when a value-form child segment uses OpenAPI {param} syntax', () => {
    const root = defineRootContext('/api');

    expect(() => defineChildContext(root, '/things/{id}')).toThrow(
      new TypeError(
        "hono-typed-router: defineChildContext: the path '/things/{id}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/things/:id'.",
      ),
    );
  });

  it('throws when a curried child segment uses OpenAPI {param} syntax', () => {
    const root = defineRootContext('/api');
    const child = defineChildContext<typeof root>();

    expect(() => child('/things/{id}/parts/{partId}')).toThrow(
      new TypeError(
        "hono-typed-router: defineChildContext: the path '/things/{id}/parts/{partId}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/things/:id/parts/:partId'.",
      ),
    );
  });

  it('throws the same errors from the extendRouteContext constructors', () => {
    const root = extended.defineRootContext('/api');

    expect(() => extended.defineRootContext('{id}')).toThrow(
      "hono-typed-router: defineRootContext: the path '{id}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write ':id'.",
    );
    expect(() => extended.defineChildContext(root, '/{id}')).toThrow(
      "hono-typed-router: defineChildContext: the path '/{id}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/:id'.",
    );
    expect(() => extended.defineChildContext<typeof root>()('/{id}')).toThrow(
      "hono-typed-router: defineChildContext: the path '/{id}' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/:id'.",
    );
  });

  it('omits the colon when the param has no name', () => {
    expect(() => defineRootContext('/a/{')).toThrow(
      "hono-typed-router: defineRootContext: the path '/a/{' uses OpenAPI {param} syntax. Context paths use Hono syntax: write '/a/'.",
    );
    expect(() => defineRootContext('/a/{}/b')).toThrow("write '/a//b'.");
  });

  it('accepts a slash and a brace inside a Hono regex param', () => {
    expect(defineRootContext('/api/:id{a/{x}}').path).toBe('/api/:id{a/{x}}');
  });

  it('accepts Hono paths and Hono regex params unchanged', () => {
    const root = defineRootContext('/api/:orgId');
    const regex = defineRootContext('/items/:id{[0-9]+}');
    const child = defineChildContext(root, '/things/:id{[0-9]+}');
    const curried = defineChildContext<typeof root>()('/things/:id');

    expect(root.path).toBe('/api/:orgId');
    expect(regex.path).toBe('/items/:id{[0-9]+}');
    expect(child.path).toBe('/api/:orgId/things/:id{[0-9]+}');
    expect(child.segment).toBe('/things/:id{[0-9]+}');
    expect(curried.path).toBe('/things/:id');
    expect(extended.defineRootContext('/x/:id').path).toBe('/x/:id');
  });
});
