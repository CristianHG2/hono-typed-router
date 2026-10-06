import { z } from '@hono/zod-openapi';
import type { ParamKeys } from 'hono/types';
import type { ZodObject, ZodString, ZodType } from 'zod';
import { honoJoin } from './route-match';

/** OpenAPI has no optional path param, so a `:param?` is not a key. */
type RequiredParamKeys<TPath extends string> = Exclude<ParamKeys<TPath>, `${string}?`>;

/** @internal */
export type PathParamSchemas<TPath extends string> = {
  [K in RequiredParamKeys<TPath>]: ZodString;
};

type MergedParamSchemas<TPath extends string, TDeclared> = {
  [K in keyof TDeclared | RequiredParamKeys<TPath>]: K extends keyof TDeclared
    ? TDeclared[K]
    : ZodString;
};

/**
 * @internal
 *
 * If a declared `z.object` has each path param, the config keeps its type, which costs no
 * extra instantiations.
 */
export type WithPathParams<TPath extends string, C> = [RequiredParamKeys<TPath>] extends [never]
  ? C
  : C extends { request: infer R }
    ? R extends { params: infer P }
      ? P extends ZodObject<infer TDeclared, infer TConfig>
        ? [Exclude<RequiredParamKeys<TPath>, keyof TDeclared>] extends [never]
          ? C
          : Omit<C, 'request'> & {
              request: WithParams<R, ZodObject<MergedParamSchemas<TPath, TDeclared>, TConfig>>;
            }
        : C
      : Omit<C, 'request'> & { request: R & { params: ZodObject<PathParamSchemas<TPath>> } }
    : C & { request: { params: ZodObject<PathParamSchemas<TPath>> } };

// A mapped type over the whole config costs about 10 times more instantiations in `openapi`
// (measured on 100 routes), so only `request` is mapped.
type WithParams<R, P> = { [K in keyof R]: K extends 'params' ? P : R[K] };

type ParamName<K> = K extends `${infer N}?` ? N : K;

/** @internal */
export type CheckPathParams<TPath extends string, C> = string extends TPath
  ? unknown
  : C extends { request: { params: ZodObject<infer TDeclared> } }
    ? [Exclude<keyof TDeclared, ParamName<ParamKeys<TPath>>>] extends [never]
      ? unknown
      : {
          request: {
            params: `The path '${TPath}' has no param named '${Exclude<keyof TDeclared, ParamName<ParamKeys<TPath>>> & string}'`;
          };
        }
    : unknown;

// `:name`, `:name{regex}` and `:name?`, as Hono's `ParamKeys` reads them.
const PARAM = /:([^/{?]+)(?:{[^}]*})?(\?)?/g;

type ParamsConfig = { path?: string; request?: { params?: SchemaLike } };

// One member of `ZodType`: a full `ZodType` comparison costs about 70,000 instantiations.
type SchemaLike = Pick<ZodType, '_zod'>;

/**
 * The runtime twin of {@link WithPathParams}. Limit: a `config.path` that `transformRoute`
 * sets later does not add params.
 */
export function withPathParams<C extends ParamsConfig>(servedPath: string, config: C): C {
  const path = honoJoin(servedPath, toHonoPath(config.path ?? '/'));
  const keys = [...path.matchAll(PARAM)].filter(([, , optional]) => optional === undefined);

  if (keys.length === 0) {
    return config;
  }

  const declared = config.request?.params;

  if (declared !== undefined && !isZodObject(declared)) {
    return config;
  }

  // Concrete schema types: a `ZodType` value type costs about 84,000 type instantiations.
  const missing: Record<string, ZodString> = {};

  for (const [, name] of keys) {
    if (name !== undefined && !(declared !== undefined && name in declared.shape)) {
      missing[name] = z.string();
    }
  }

  if (declared !== undefined && Object.keys(missing).length === 0) {
    return config;
  }

  const params = declared === undefined ? z.object(missing) : extendObject(declared, missing);

  // SAFETY: only `request.params` changes, to another zod schema, which `ParamsConfig` allows.
  return { ...config, request: { ...config.request, params } } as C;
}

/**
 * `safeExtend` (zod 4.1 and later) keeps the refinements. In zod 4.1, `extend` throws for an
 * object with refinements. In zod 4.0, `extend` drops them.
 */
function extendObject(declared: ObjectSchema, missing: Record<string, ZodString>) {
  return declared.safeExtend === undefined
    ? declared.extend(missing)
    : declared.safeExtend(missing);
}

// Only the members that `withPathParams` uses: a full `ZodObject` comparison costs about
// 70,000 type instantiations. `safeExtend` is optional because zod 4.0 does not have it.
type ObjectSchema = Pick<ZodObject, 'shape' | 'extend'> & Partial<Pick<ZodObject, 'safeExtend'>>;

// Duck-typed: `instanceof` fails for a schema from a second copy of zod.
function isZodObject(schema: SchemaLike): schema is SchemaLike & ObjectSchema {
  return 'shape' in schema && 'extend' in schema;
}

/** Changes OpenAPI `{param}` to Hono `:param`, with the regex of @hono/zod-openapi. */
export function toHonoPath(path: string): string {
  return path.replaceAll(/\/{(.+?)}/g, '/:$1');
}

/**
 * Hono joins the route path to the segment first, and then the parent path. This order
 * changes only a route path `''` under a segment `'/'` or `''`: it gives `'/api'`, not `'/api/'`.
 */
export function routeJoin(fullPath: string, segment: string, path: string): string {
  return honoJoin(fullPath, path === '' && (segment === '/' || segment === '') ? '/' : path);
}
