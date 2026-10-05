// Makes sure that each ```ts block in the docs has a compiled twin in its `*.test-d.ts` mirror.
// Run with `node --experimental-strip-types tools/check-doc-blocks.ts`. No dependencies.
//
// A block matches when its normalized text is a substring of the normalized mirror. The
// normalization is the same on both sides:
//   1. Remove comments (string- and template-aware). This also removes `@ts-expect-error`.
//   2. Remove each statement that starts a line with `import`, `declare` or `expectTypeOf(`, up
//      to its `;` at bracket depth 0 (or the `}` that closes a `declare class` body).
//   3. Remove all whitespace.
//   4. Remove a `,` before `)`, `]`, `}` or `>`. The formatter adds trailing commas when a
//      mirror block is one scope deeper and wraps differently.
// The check skips a block when the nearest non-blank line above its fence is
// `<!-- doc-check: skip -->`. A fence with the language `ts` or `typescript` is a ts block. An
// indented ts fence (in a list) fails the check, because the checker reads only fences at
// column 0. Move the block out of the list or mark it skipped.
//
// Limits: the match is textual. It does not prove that a block compiles as written.
//   - A block can name an import that the mirror does not have.
//   - A type claim in an `expectTypeOf(...)` line of a block is not checked.
//   - A block can declare a type that differs from the mirror's.
//   - A comment that states a type or a result is not checked.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const SKIP_MARKER = '<!-- doc-check: skip -->';

const TS_LANGUAGES = new Set(['ts', 'typescript']);

// The language of a fence line, such as `ts` for "```ts title", or `undefined` for a non-fence.
const FENCE = /^(\s*)```(\S*)/u;

const REMOVED_STATEMENT = /^(?:import[\s{]|import$|declare\s|expectTypeOf[(<])/u;

const EXPORT_KEYWORD = /^(\s*)export\s+(?:default\s+)?/gmu;

const TRAILING_COMMA = /,(?=[)\]}>])/gu;

const WHITESPACE = /\s+/gu;

const PAIRS: readonly (readonly [string, string])[] = [
  ['README.md', 'src/docs.test-d.ts'],
  ['docs/usage.md', 'src/usage-docs.test-d.ts'],
  ['docs/api.md', 'src/api-docs.test-d.ts'],
];

interface DocBlock {
  line: number;
  code: string;
}

interface Extracted {
  blocks: DocBlock[];
  /** The lines of the indented ts fences that are not marked skipped. */
  indented: number[];
}

const OPENERS = new Set(['(', '[', '{']);

const CLOSERS = new Set([')', ']', '}']);

const QUOTES = new Set(['"', "'", '`']);

// The index after the string literal that opens at `start`.
function skipString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;

  while (index < text.length && text[index] !== quote) {
    index += text[index] === '\\' ? 2 : 1;
  }

  return index + 1;
}

function stripComments(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1];

    if (QUOTES.has(char)) {
      const end = skipString(text, index);

      out += text.slice(index, end);
      index = end;
    } else if (char === '/' && next === '/') {
      const end = text.indexOf('\n', index);

      index = end === -1 ? text.length : end;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);

      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }

  return out;
}

// The index after the statement that starts at `start`. A `declare class` has no `;`, so the
// `}` that returns to depth 0 also ends a `declare` statement.
function statementEnd(text: string, start: number): number {
  const endsAtBrace = text.startsWith('declare', start);
  let depth = 0;
  let index = start;

  while (index < text.length) {
    const char = text[index] ?? '';

    if (QUOTES.has(char)) {
      index = skipString(text, index);
    } else if (char === ';' && depth === 0) {
      return index + 1;
    } else {
      if (OPENERS.has(char)) depth += 1;

      if (CLOSERS.has(char)) {
        depth -= 1;

        if (endsAtBrace && depth === 0 && char === '}') {
          return text[index + 1] === ';' ? index + 2 : index + 1;
        }
      }

      index += 1;
    }
  }

  return text.length;
}

function stripIgnoredStatements(text: string): string {
  let out = '';
  let index = 0;

  while (index < text.length) {
    const lineEnd = text.indexOf('\n', index);
    const end = lineEnd === -1 ? text.length : lineEnd + 1;
    const indent = text.slice(index, end).search(/\S/u);
    const statementStart = indent === -1 ? end : index + indent;

    if (REMOVED_STATEMENT.test(text.slice(statementStart, end).trimEnd())) {
      index = statementEnd(text, statementStart);
    } else {
      out += text.slice(index, end);
      index = end;
    }
  }

  return out;
}

function normalize(code: string): string {
  return stripIgnoredStatements(stripComments(code))
    .replaceAll(EXPORT_KEYWORD, '$1')
    .replaceAll(WHITESPACE, '')
    .replaceAll(TRAILING_COMMA, '');
}

function extractBlocks(markdown: string): Extracted {
  const lines = markdown.split('\n');
  const blocks: DocBlock[] = [];
  const indented: number[] = [];
  let open: DocBlock | undefined;
  let skipping = false;
  let lastNonBlank = '';

  for (const [index, line] of lines.entries()) {
    const fence = FENCE.exec(line);
    const marked = lastNonBlank.trim() === SKIP_MARKER;

    if (open) {
      if (line.trim() === '```') {
        if (!skipping) blocks.push(open);
        open = undefined;
      } else {
        open.code += `${line}\n`;
      }
    } else if (fence !== null) {
      const [, indent = '', language = ''] = fence;
      const ts = TS_LANGUAGES.has(language);

      if (ts && indent !== '' && !marked) indented.push(index + 1);

      // Skip the body of a non-ts or indented fence, so that it is not read as prose.
      open = { line: index + 1, code: '' };
      skipping = !ts || indent !== '' || marked;
    }

    if (line.trim() !== '') lastNonBlank = line;
  }

  return { blocks, indented };
}

let failures = 0;

let checked = 0;

for (const [docPath, mirrorPath] of PAIRS) {
  const mirror = normalize(readFileSync(join(ROOT, mirrorPath), 'utf8'));

  const { blocks, indented } = extractBlocks(readFileSync(join(ROOT, docPath), 'utf8'));

  for (const line of indented) {
    failures += 1;
    console.error(
      `${docPath}:${line} ts fence is indented (inside a list). The checker reads only fences at column 0: move the block out of the list, or put ${SKIP_MARKER} above it.`,
    );
  }

  for (const block of blocks) {
    checked += 1;

    if (!mirror.includes(normalize(block.code))) {
      failures += 1;

      const head = block.code.split('\n').slice(0, 3);

      console.error(`${docPath}:${block.line} ts block has no twin in ${mirrorPath}`);
      console.error(head.map((line) => `    ${line}`).join('\n'));
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} of ${checked} doc blocks have no twin.`);
  process.exitCode = 1;
} else {
  console.log(`check:docs: ${checked} doc blocks match their mirrors.`);
}
