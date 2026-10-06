import type { ParentContext } from './context';
import type { ContextBindings, READS, SETS } from './env';

export type { HandlerReads, HandlerSets, HandlerVars, READS, SETS } from './env';

/**
 * The Hono `Env` of a middleware that runs on `TContext` and sets `TNewVars`, for
 * `createMiddleware<ContextEnv<typeof ctx, { session: Session }>>(...)`. `.middleware()` accepts
 * the middleware on each context that has the vars of `TContext`, and adds only `TNewVars`. Do
 * not pass a type argument to `.middleware()` for this middleware.
 */
export type ContextEnv<TContext extends ParentContext, TNewVars extends object = {}> = {
  [
    K in keyof FullContextEnv<TContext, TNewVars> as K extends 'Bindings'
      ? [keyof ContextBindings<TContext>] extends [never]
        ? never
        : K
      : K
  ]: FullContextEnv<TContext, TNewVars>[K];
};

/**
 * `ContextEnv` maps over this type to drop an empty `Bindings`. A mapped type keeps the
 * `ContextEnv` alias in consumer declarations. A conditional type loses it, and the consumer
 * then cannot name `READS` and `SETS` (TS4023).
 *
 * @internal
 */
export type FullContextEnv<TContext extends ParentContext, TNewVars extends object> = {
  Bindings: ContextBindings<TContext>;
  Variables: TContext['vars'] & TNewVars;
  readonly [READS]: TContext['vars'];
  readonly [SETS]: TNewVars;
};
