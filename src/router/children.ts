import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Schema } from 'hono';

/**
 * A child router for `makeRouter` and `mountRouter`. A `ChildRouter[]` variable skips
 * {@link CheckChildren}, and the app type then has no routes of those children.
 */
export type ChildRouter = () => OpenAPIHono<any, any, any>;

/**
 * @internal
 *
 * The match is on `OpenAPIHono`, not on the base `Hono`: a match on the base class compares
 * each member (about 9 times more types with 50 children).
 */
export type ChildSchema<TChild> = TChild extends () => OpenAPIHono<any, infer S extends Schema, any>
  ? 0 extends 1 & S
    ? never
    : NonEmptySchema<S>
  : never;

type NonEmptySchema<S> = S extends unknown ? (keyof S extends never ? never : S) : never;

/**
 * @internal
 *
 * The schema keys are already full paths. The schemas are intersected, not joined in a union:
 * with 500 children, a union makes `testClient(app)` fail with TS2589.
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

// TypeScript infers one member of a union from an intersection of one function for each member.
type LastOf<T> =
  UnionToIntersection<T extends unknown ? (value: T) => void : never> extends (
    value: infer L,
  ) => void
    ? L
    : never;

// Identity, not assignability, because one child router type can be assignable to another.
type IsUnion<T> =
  (<G>() => G extends T ? 1 : 2) extends <G>() => G extends LastOf<T> ? 1 : 2 ? false : true;

/**
 * @internal
 *
 * TypeScript can reduce the element type of a children array variable to one child, and the
 * app type then loses the routes of the other children. Limit: an array of children of one
 * type (`routers.map(() => r)`) also fails. The check costs about 23,000 instantiations for a
 * union of 50 children.
 */
export type CheckChildren<TChildren extends readonly unknown[]> = number extends TChildren['length']
  ? true extends IsUnion<TChildren[number]>
    ? unknown
    : [ChildSchema<TChildren[number]>] extends [never]
      ? unknown
      : 'Pass children inline or as const: a children array variable has one element type, and the app type can lose the routes of some children'
  : unknown;
