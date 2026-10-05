import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Schema } from 'hono';

/**
 * A child router, as `makeRouter` and `mountRouter` accept it. A `ChildRouter[]` variable
 * opts out of {@link CheckChildren}; the app type then has no routes of those children.
 */
export type ChildRouter = () => OpenAPIHono<any, any, any>;

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * The route schema a child thunk contributes to its parent's type: the child app's
 * `Schema`. Empty (`{}`) and `any` schemas (an untyped child, or a widened
 * `(() => OpenAPIHono<any, any, any>)[]` array) contribute nothing. The schema is
 * inferred from `OpenAPIHono`, not from its base `Hono`: matching the same generic class
 * reads its type arguments directly, while matching the base class compares every member
 * (about 9x more types with 50 children).
 */
export type ChildSchema<TChild> = TChild extends () => OpenAPIHono<any, infer S extends Schema, any>
  ? 0 extends 1 & S
    ? never
    : NonEmptySchema<S>
  : never;

/** Drops empty (`{}`) members; distributes, since a child's schema is itself a union. */
type NonEmptySchema<S> = S extends unknown ? (keyof S extends never ? never : S) : never;

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * Adds the children's schemas to the app's `Schema`, so `hc` / `testClient` see the
 * children's routes. Children are mounted with `app.route('/', child())` and their
 * schema keys are already full paths, so Hono's `MergeSchemaPath<S, '/'>` would not
 * change them. The schemas are intersected, as in `OpenAPIHono#route`'s own type. A
 * union also works with `hc`, but with 500 children `testClient(app)` fails with
 * TS2589 (excessively deep), while the intersection still type-checks.
 */
export type WithChildSchemas<TApp, TChildSchemas extends Schema> = [TChildSchemas] extends [never]
  ? TApp
  : TApp extends OpenAPIHono<infer E, infer S, infer B>
    ? OpenAPIHono<E, S & UnionToIntersection<TChildSchemas>, B>
    : TApp;

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

// One member of a union: the parameter type that the intersection of the member functions infers.
type LastOf<T> =
  UnionToIntersection<T extends unknown ? (value: T) => void : never> extends (
    value: infer L,
  ) => void
    ? L
    : never;

// Identity, not assignability: a child router type can be assignable to another one. Not
// distributive: one comparison of the whole union with one of its members.
type IsUnion<T> =
  (<G>() => G extends T ? 1 : 2) extends <G>() => G extends LastOf<T> ? 1 : 2 ? false : true;

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * `unknown`, or an error message for a children array variable (not a tuple) whose element
 * type is one typed child router. TypeScript can reduce the element type of such an array to
 * one child, and the app type then loses the routes of the other children. An element union
 * keeps every child, and `ChildRouter[]` (no route types) is the opt-out, so both pass.
 *
 * Known false positives: an array variable with only one child, and an array whose children
 * have one type, such as `routers.map(() => r)`, `(typeof r)[]`, or routers with identical
 * types. Pass them inline or type them as `ChildRouter[]`. The check costs about 23,000
 * instantiations for an array variable with a union of 50 children.
 */
export type CheckChildren<TChildren extends readonly unknown[]> = number extends TChildren['length']
  ? true extends IsUnion<TChildren[number]>
    ? unknown
    : [ChildSchema<TChildren[number]>] extends [never]
      ? unknown
      : 'Pass children inline or as const: a children array variable has one element type, and the app type can lose the routes of some children'
  : unknown;
