// Fails when the type-checking cost grows past the budget in `tools/type-budget.json`.
// Run with `node --experimental-strip-types tools/type-budget.ts [--update]`. No dependencies.
//
// It reads two numbers from `tsc --extendedDiagnostics --checkers 1`. One checker makes the
// count independent of the CPU count of the machine:
//   1. `testTypes`: the instantiations of `tsc -p tsconfig.test-types.json`.
//   2. `perRoute`: the instantiations of each route in a generated fixture that matches the README
//      "Scaling" setup: 50 routers with 2 routes each, every route with path params, a JSON body or
//      response, `handle`, and an `onError` arm. The figure is
//      (fixture - baseline) / routes. The baseline is the same file with no routers.
// The script writes the fixture under `node_modules/.cache/type-budget/` at run time.
// `--update` rewrites the budget file: the current values, the date, and each max at current + 10%.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BUDGET_PATH = join(ROOT, 'tools', 'type-budget.json');

const FIXTURE_DIR = join(ROOT, 'node_modules', '.cache', 'type-budget');

const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

const ROUTERS = 50;

const ROUTES_PER_ROUTER = 2;

const HEADROOM = 1.1;

const NOTE =
  'Written by `pnpm check:type-budget --update`. Counts use `tsc --checkers 1`, so they do not ' +
  'depend on the CPU count and are lower than the default multi-checker counts. ' +
  'perRoute = (fixture - baseline) / (routers * routesPerRouter). Each max is current + 10%.';

interface Diagnostics {
  instantiations: number;
  types: number;
}

interface Budget {
  note: string;
  measuredOn: string;
  typescript: string;
  checkers: number;
  testTypes: { current: number; max: number };
  perRoute: {
    routers: number;
    routesPerRouter: number;
    current: number;
    max: number;
  };
}

function readCount(output: string, label: string): number {
  const match = new RegExp(`^${label}:\\s+(\\d+)`, 'mu').exec(output);

  if (!match?.[1]) {
    throw new Error(`type-budget: no "${label}" line in the tsc output`);
  }

  return Number(match[1]);
}

function measure(project: string): Diagnostics {
  const result = spawnSync(
    TSC,
    ['-p', project, '--noEmit', '--extendedDiagnostics', '--checkers', '1'],
    { cwd: ROOT, encoding: 'utf8' },
  );

  const output = `${result.stdout}${result.stderr}`;

  if (result.status !== 0 || output.includes('error TS')) {
    const errors = output.split('\n').filter((line) => line.includes('error TS'));

    throw new Error(
      `type-budget: tsc failed for ${project}; fix the type errors first\n${errors.join('\n')}`,
    );
  }

  return {
    instantiations: readCount(output, 'Instantiations'),
    types: readCount(output, 'Types'),
  };
}

function fixtureSource(routers: number): string {
  const lines = [
    "import { z } from 'zod';",
    'import {',
    '  createRouter,',
    '  defineChildContext,',
    '  defineRootContext,',
    '  handle,',
    '  jsonRequest,',
    '  jsonResponse,',
    '  mountRouter,',
    '  onError,',
    "} from '../../../src/index';",
    '',
    'class NotFoundError extends Error {}',
    'const Thing = z.object({ id: z.string(), name: z.string() });',
    'const CreateThing = z.object({ name: z.string() });',
    'const ErrorBody = z.object({ message: z.string() });',
    'const Params = z.object({ id: z.string() });',
    "const apiContext = defineRootContext('/api');",
    'const makeRouter = createRouter();',
    'const notFoundArm = onError(NotFoundError, (_e, c) => c.json({ message: "Not found" }, 404));',
  ];

  for (let index = 0; index < routers; index += 1) {
    lines.push(`
const context${index} = defineChildContext(apiContext, '/r${index}/:id').middleware<{ v${index}: string }>(
  async (c, next) => { c.set('v${index}', 'x'); await next(); },
);
const router${index} = makeRouter(context${index}, ({ app, defineRoute }) => {
  const getRoute = defineRoute('get', {
    request: { params: Params },
    responses: { 200: jsonResponse(Thing, 'A thing'), 404: jsonResponse(ErrorBody, 'Not found') },
  });
  const putRoute = defineRoute('put', {
    request: { params: Params, ...jsonRequest(CreateThing, 'The new thing') },
    responses: { 200: jsonResponse(Thing, 'A thing'), 404: jsonResponse(ErrorBody, 'Not found') },
  });
  return app
    .openapi(getRoute, (c) =>
      handle(c, async ({ param }) => c.json({ id: param.id, name: c.var.v${index} }, 200), [notFoundArm]),
    )
    .openapi(putRoute, (c) =>
      handle(c, async ({ param, json }) => c.json({ id: param.id, name: json.name }, 200), [notFoundArm]),
    );
});`);
  }

  const children = Array.from({ length: routers }, (_unused, index) => `router${index}`);

  lines.push(`export const app = mountRouter(apiContext, [${children.join(', ')}]);`, '');

  return lines.join('\n');
}

function writeFixture(name: string, routers: number): string {
  const testTypes = readFileSync(join(ROOT, 'tsconfig.test-types.json'), 'utf8');

  const tsconfig = testTypes
    .replace(/"include":\s*\[[^\]]*\]/u, `"include": ["${name}.ts"]`)
    .replace(/"\$schema":[^\n]*\n/u, '');

  const project = join(FIXTURE_DIR, `tsconfig.${name}.json`);

  writeFileSync(join(FIXTURE_DIR, `${name}.ts`), fixtureSource(routers));
  writeFileSync(project, tsconfig);

  return project;
}

function readBudget(): Budget {
  // SAFETY: `--update` writes the budget file from a `Budget` value. The code below makes sure
  // that the two maxes are numbers.
  const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as Budget;

  if (!Number.isFinite(budget.testTypes?.max) || !Number.isFinite(budget.perRoute?.max)) {
    throw new TypeError(`type-budget: ${BUDGET_PATH} has no testTypes.max or perRoute.max number`);
  }

  return budget;
}

function typescriptVersion(): string {
  const result = spawnSync(TSC, ['--version'], { cwd: ROOT, encoding: 'utf8' });

  return result.stdout.trim().replace(/^Version\s+/u, '');
}

mkdirSync(FIXTURE_DIR, { recursive: true });

const started = Date.now();

const baseline = measure(writeFixture('baseline', 0));

const fixture = measure(writeFixture('fixture', ROUTERS));

const testTypes = measure('tsconfig.test-types.json');

const routes = ROUTERS * ROUTES_PER_ROUTER;

const perRoute = Math.round((fixture.instantiations - baseline.instantiations) / routes);

console.log(
  [
    `test-types: ${testTypes.instantiations} instantiations, ${testTypes.types} types`,
    `fixture: ${fixture.instantiations} instantiations (baseline ${baseline.instantiations}), ` +
      `${routes} routes, ${perRoute} per route`,
    `measured in ${((Date.now() - started) / 1000).toFixed(2)} s`,
  ].join('\n'),
);

if (process.argv.includes('--update')) {
  const budget: Budget = {
    note: NOTE,
    measuredOn: new Date().toISOString().slice(0, 10),
    typescript: typescriptVersion(),
    checkers: 1,
    testTypes: {
      current: testTypes.instantiations,
      max: Math.ceil(testTypes.instantiations * HEADROOM),
    },
    perRoute: {
      routers: ROUTERS,
      routesPerRouter: ROUTES_PER_ROUTER,
      current: perRoute,
      max: Math.ceil(perRoute * HEADROOM),
    },
  };

  writeFileSync(BUDGET_PATH, `${JSON.stringify(budget, undefined, 2)}\n`);
  console.log(`type-budget: wrote ${BUDGET_PATH}`);
} else {
  const budget = readBudget();
  const failures: string[] = [];

  if (testTypes.instantiations > budget.testTypes.max) {
    failures.push(
      `test-types instantiations ${testTypes.instantiations} exceed the budget ` +
        `${budget.testTypes.max} (recorded ${budget.testTypes.current} on ${budget.measuredOn})`,
    );
  }

  if (perRoute > budget.perRoute.max) {
    failures.push(
      `per-route instantiations ${perRoute} exceed the budget ${budget.perRoute.max} ` +
        `(recorded ${budget.perRoute.current} on ${budget.measuredOn})`,
    );
  }

  if (failures.length > 0) {
    console.error(failures.map((failure) => `type-budget: ${failure}`).join('\n'));

    const installed = typescriptVersion();

    if (installed !== budget.typescript) {
      console.error(
        `The budget was recorded with TypeScript ${budget.typescript}, now ${installed}. ` +
          'If only TypeScript changed, run --update.',
      );
    }

    console.error(
      'If the increase is intended, run `pnpm check:type-budget --update` and commit the file.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      [
        `perRoute ${perRoute} (recorded ${budget.perRoute.current}, max ${budget.perRoute.max})`,
        `testTypes ${testTypes.instantiations} ` +
          `(recorded ${budget.testTypes.current}, max ${budget.testTypes.max})`,
      ].join('\n'),
    );
  }
}
