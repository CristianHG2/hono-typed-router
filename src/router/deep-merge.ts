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

/** The runtime twin of `DeepMerge` in `./types`. Change the two together. */
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
