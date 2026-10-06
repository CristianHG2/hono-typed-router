import type { ZodType, ZodUnion } from 'zod';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

type ZodSchemaLike = { _def: unknown; or: (other: unknown) => unknown };

function isZodSchema(value: unknown): value is ZodSchemaLike {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_def' in value &&
    // SAFETY: `value` is a non-null object, so a read of `or` cannot throw.
    typeof (value as { or?: unknown }).or === 'function'
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }

    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }

    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);

    if (ak.length !== bk.length) {
      return false;
    }

    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) {
        return false;
      }

      if (!deepEqual(a[k], b[k])) {
        return false;
      }
    }

    return true;
  }

  return false;
}

function mergeArrays(base: readonly unknown[], route: readonly unknown[]): unknown[] {
  const out: unknown[] = [...base];

  for (const item of route) {
    if (!out.some((existing) => deepEqual(existing, item))) {
      out.push(item);
    }
  }

  return out;
}

type IsPlainObject<T> = T extends
  | readonly unknown[]
  | ((...args: any[]) => any)
  | Date
  | { _def: unknown }
  ? false
  : T extends object
    ? true
    : false;

/**
 * @internal
 *
 * The type of the runtime `deepMerge`. The route (`B`) wins, except:
 *
 * - Two zod schemas give `ZodUnion<readonly [A, B]>` (`base.or(route)`).
 * - Two arrays give `(A[number] | B[number])[]`. Two `middleware` tuples give `[...A, ...B]`.
 * - Two plain objects merge key by key. A route key that can be `undefined` gives
 *   `A[K] | DeepMerge<A[K], B[K]> | undefined`, because the runtime copies an explicit `undefined`.
 * - A route `security: []` replaces the base value. Other empty arrays merge.
 *
 * Limit: the merge drops the `?` modifier, so a key from an optional property is required.
 */
export type DeepMerge<A, B> = A extends ZodType
  ? B extends ZodType
    ? ZodUnion<readonly [A, B]>
    : B
  : A extends readonly unknown[]
    ? B extends readonly unknown[]
      ? (A[number] | B[number])[]
      : B
    : [IsPlainObject<A>, IsPlainObject<B>] extends [true, true]
      ? MergeObjects<A, B>
      : B;

// TypeScript infers `security: []` as `never[]` or `[]`.
type MergeObjects<A, B> = {
  [K in keyof A | keyof B]: K extends keyof B
    ? K extends keyof A
      ? K extends 'security'
        ? B[K] extends readonly never[]
          ? []
          : MergeKey<A[K], B[K]>
        : K extends 'middleware'
          ? MergeMiddleware<A[K], B[K]>
          : MergeKey<A[K], B[K]>
      : B[K]
    : K extends keyof A
      ? A[K]
      : never;
};

// Two tuples keep their order and length, so `RouteConfigToEnv` of zod-openapi sees each
// middleware.
type MergeMiddleware<A, B> = A extends readonly unknown[]
  ? B extends readonly unknown[]
    ? number extends A['length'] | B['length']
      ? MergeKey<A, B>
      : [...A, ...B]
    : MergeKey<A, B>
  : MergeKey<A, B>;

type MergeKey<A, B> = undefined extends B
  ? A | DeepMerge<A, Exclude<B, undefined>> | Extract<B, undefined>
  : DeepMerge<A, B>;

/** The runtime twin of the type `DeepMerge` above. Change the two together. */
export function deepMerge(
  base: Record<string, unknown>,
  route: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };

  for (const key of Object.keys(route)) {
    const routeVal = route[key];
    const baseVal = out[key];

    if (key === 'security' && Array.isArray(routeVal) && routeVal.length === 0) {
      // OpenAPI: an operation-level `security: []` removes the inherited requirement.
      out[key] = routeVal;
    } else if (Array.isArray(baseVal) && Array.isArray(routeVal)) {
      out[key] = mergeArrays(baseVal, routeVal);
    } else if (isPlainObject(baseVal) && isPlainObject(routeVal)) {
      out[key] = deepMerge(baseVal, routeVal);
    } else if (isZodSchema(baseVal) && isZodSchema(routeVal)) {
      out[key] = baseVal.or(routeVal);
    } else {
      out[key] = routeVal;
    }
  }

  return out;
}
