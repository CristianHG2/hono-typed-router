import { z } from '@hono/zod-openapi';
import type { ParamKeys } from 'hono/types';
import type { ZodObject, ZodString, ZodType } from 'zod';

/**
 * The required param keys of a Hono path. An optional `:param?` is not a key: OpenAPI cannot
 * show an optional path parameter, so `defineRoute` does not add it to `request.params`.
 */
type RequiredParamKeys<TPath extends string> = Exclude<ParamKeys<TPath>, `${string}?`>;

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * The zod shape that `defineRoute` derives from a context path: a `ZodString` for each
 * `:param` (also `:param{regex}`). An optional `:param?` is not in the shape.
 */
export type PathParamSchemas<TPath extends string> = {
  [K in RequiredParamKeys<TPath>]: ZodString;
};

/**
 * A declared params shape with the missing path params added, in one mapped type. A
 * declared key wins over the path key with the same name.
 */
type MergedParamSchemas<TPath extends string, TDeclared> = {
  [K in keyof TDeclared | RequiredParamKeys<TPath>]: K extends keyof TDeclared
    ? TDeclared[K]
    : ZodString;
};

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * The route config with `request.params` built from the context path `TPath`:
 *
 * - no params declared: a `z.object` with one string for each required path param;
 * - a declared `z.object`: its keys and types are kept, and the missing path params are
 *   added as strings. When it has every path param, the config is unchanged, which costs
 *   no extra type instantiations;
 * - any other params schema, or a path without required params: the config is unchanged.
 *
 * An optional `:param?` is not added (see {@link RequiredParamKeys}).
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

// `Omit` for the config and a mapped type for `request`: a mapped type over the whole config
// costs about 10 times more instantiations in `openapi` (measured on 100 routes).
type WithParams<R, P> = { [K in keyof R]: K extends 'params' ? P : R[K] };

/** A Hono param key without its optional `?` marker. */
type ParamName<K> = K extends `${infer N}?` ? N : K;

/**
 * @internal Exported for declaration emit; not part of the public API.
 *
 * `unknown`, or an error type when a declared `z.object` params schema has a key that the
 * context path does not have. A widened `string` path is not checked.
 */
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

/** The part of a route config that `withPathParams` reads. */
type ParamsConfig = { path?: string; request?: { params?: SchemaLike } };

// One member of `ZodType`: a full `ZodType` comparison costs about 70,000 instantiations.
type SchemaLike = Pick<ZodType, '_zod'>;

/**
 * Builds `request.params` from the required params of the served path joined with
 * `config.path`. When the route has no params, it gets a `z.object` with a string for each
 * param. When the route has a `z.object`, the missing params are added, and its own keys
 * stay as declared. An optional `:param?` is not added. Another schema owns the params, so
 * the config does not change.
 *
 * A `config.path` that `transformRoute` sets later is not read here, so its params are not
 * added.
 */
export const withPathParams = <C extends ParamsConfig>(servedPath: string, config: C): C => {
  const path = joinPath(servedPath, toHonoPath(config.path ?? '/'));
  const keys = [...path.matchAll(PARAM)].filter(([, , optional]) => optional === undefined);

  if (keys.length === 0) return config;

  const declared = config.request?.params;

  if (declared !== undefined && !isZodObject(declared)) return config;

  // Concrete schema types: a `ZodType` value type costs about 84,000 type instantiations.
  const missing: Record<string, ZodString> = {};

  for (const [, name] of keys) {
    if (name !== undefined && !(declared !== undefined && name in declared.shape)) {
      missing[name] = z.string();
    }
  }

  if (declared !== undefined && Object.keys(missing).length === 0) return config;

  const params = declared === undefined ? z.object(missing) : extendObject(declared, missing);

  // SAFETY: the copy is `config` with `request.params` replaced by another zod schema, which
  // `ParamsConfig` allows.
  return { ...config, request: { ...config.request, params } } as C;
};

/**
 * Adds keys to a declared object and keeps its config, such as `.strict()`. `safeExtend`
 * (zod 4.1 and later) also keeps its refinements. In zod 4.1, `extend` throws for an
 * object with refinements, and in zod 4.0 it drops them.
 */
const extendObject = (declared: ObjectSchema, missing: Record<string, ZodString>) =>
  declared.safeExtend === undefined ? declared.extend(missing) : declared.safeExtend(missing);

// Only the members that `withPathParams` uses: a full `ZodObject` comparison costs about
// 70,000 type instantiations. `safeExtend` is optional because zod 4.0 does not have it.
type ObjectSchema = Pick<ZodObject, 'shape' | 'extend'> & Partial<Pick<ZodObject, 'safeExtend'>>;

// Duck-typed, as `isZodSchema` in `./lib`: a second copy of zod fails `instanceof`.
const isZodObject = (schema: SchemaLike): schema is SchemaLike & ObjectSchema =>
  'shape' in schema && 'extend' in schema;

/** OpenAPI `{param}` segments become Hono `:param` segments (same regex @hono/zod-openapi uses). */
export const toHonoPath = (path: string): string => path.replaceAll(/\/{(.+?)}/g, '/:$1');

// `'/'` is the context path itself; a root defined as `''` reads as `'/'`.
export const joinPath = (contextPath: string, routePath: string): string => {
  const base = contextPath.replace(/\/$/, '');

  return (routePath === '/' ? base : `${base}${routePath}`) || '/';
};
