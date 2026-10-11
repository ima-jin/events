/**
 * Keeps api-spec/openapi.yaml honest against the route files.
 *
 * No YAML parser is a direct dependency of this app, so the spec is scanned line by line. That is
 * deliberate and safe: the spec is hand-written in a strict block layout (paths at 2 spaces,
 * methods at 4, operation keys at 6). The expected route set is derived from whichever
 * app/api/**\/route.ts files exist in the checkout, so the test also holds for a checkout that
 * carries only a subset of the routes (and a spec filtered to match).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET as getSpec } from '../../app/api/spec/route';

const ROOT = path.resolve(__dirname, '../..');
const API_DIR = path.join(ROOT, 'app/api');
const SPEC_FILE = path.join(ROOT, 'api-spec/openapi.yaml');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;
const METHOD_PATTERN = HTTP_METHODS.join('|');
const SAFE_METHODS = new Set(['get', 'head', 'options']);
const READ_SCOPE = 'events:read';
const WRITE_SCOPE = 'events:write';

interface SpecOperation {
  path: string;
  method: string;
  operationId: string | null;
  /** Inline value of the `security:` key, or null when the key is absent. */
  securityInline: string | null;
  securityBlock: string[];
  xPublic: boolean;
}

interface ParsedSpec {
  operations: SpecOperation[];
  securitySchemes: Set<string>;
}

interface ScanState {
  section: string;
  subsection: string;
  currentOp: SpecOperation | null;
  inSecurity: boolean;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function startOperation(spec: ParsedSpec, state: ScanState, specPath: string, method: string): void {
  const op: SpecOperation = {
    path: specPath,
    method,
    operationId: null,
    securityInline: null,
    securityBlock: [],
    xPublic: false,
  };
  spec.operations.push(op);
  state.currentOp = op;
  state.inSecurity = false;
}

function scanOperationLine(state: ScanState, line: string): void {
  const op = state.currentOp;
  if (!op) return;

  const indent = indentOf(line);
  if (state.inSecurity && indent > 6) {
    op.securityBlock.push(line);
    return;
  }
  state.inSecurity = false;
  if (indent !== 6) return;

  const security = /^ {6}security:(.*)$/.exec(line);
  if (security) {
    op.securityInline = security[1].trim();
    state.inSecurity = true;
    return;
  }
  const operationId = /^ {6}operationId:\s*(\S+)/.exec(line);
  if (operationId) {
    op.operationId = operationId[1];
    return;
  }
  if (/^ {6}x-public:\s*true\s*$/.test(line)) op.xPublic = true;
}

function scanPathsLine(spec: ParsedSpec, state: ScanState, line: string, specPathHolder: { current: string }): void {
  const pathMatch = /^ {2}(\/\S*):\s*$/.exec(line);
  if (pathMatch) {
    specPathHolder.current = pathMatch[1];
    state.currentOp = null;
    state.inSecurity = false;
    return;
  }
  const methodMatch = new RegExp(`^ {4}(${METHOD_PATTERN}):\\s*$`).exec(line);
  if (methodMatch) {
    startOperation(spec, state, specPathHolder.current, methodMatch[1]);
    return;
  }
  if (indentOf(line) === 4) {
    // path-level key such as `parameters:`
    state.currentOp = null;
    state.inSecurity = false;
    return;
  }
  scanOperationLine(state, line);
}

function scanComponentsLine(spec: ParsedSpec, state: ScanState, line: string): void {
  const sub = /^ {2}(\w+):\s*$/.exec(line);
  if (sub) {
    state.subsection = sub[1];
    return;
  }
  const scheme = /^ {4}(\w+):\s*$/.exec(line);
  if (scheme && state.subsection === 'securitySchemes') spec.securitySchemes.add(scheme[1]);
}

function parseSpec(text: string): ParsedSpec {
  const spec: ParsedSpec = { operations: [], securitySchemes: new Set() };
  const state: ScanState = { section: '', subsection: '', currentOp: null, inSecurity: false };
  const specPathHolder = { current: '' };

  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const topLevel = /^([\w-]+):/.exec(line);
    if (topLevel) {
      state.section = topLevel[1];
      state.subsection = '';
      continue;
    }
    if (state.section === 'paths') scanPathsLine(spec, state, line, specPathHolder);
    if (state.section === 'components') scanComponentsLine(spec, state, line);
  }
  return spec;
}

function routeFiles(): string[] {
  return readdirSync(API_DIR, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.replaceAll(path.sep, '/'))
    .filter((entry) => path.posix.basename(entry) === 'route.ts')
    .sort((a, b) => a.localeCompare(b));
}

/** `events/[id]/hold/route.ts` -> `/api/events/{id}/hold`, `media/[...path]/route.ts` -> `/api/media/{path}`. */
function toSpecPath(routeFile: string): string {
  const dir = path.posix.dirname(routeFile);
  const converted = dir
    .split('/')
    .map((segment) => segment.replace(/^\[(?:\.\.\.)?(\w+)]$/, '{$1}'))
    .join('/');
  return `/api/${converted}`;
}

function exportedMethods(routeFile: string): string[] {
  const source = readFileSync(path.join(API_DIR, routeFile), 'utf8');
  const exportPattern = new RegExp(
    `export\\s+(?:async\\s+)?function\\s+(${METHOD_PATTERN.toUpperCase()})\\b|export\\s+const\\s+(${METHOD_PATTERN.toUpperCase()})\\b`,
    'g'
  );
  return [...source.matchAll(exportPattern)].map((match) => (match[1] ?? match[2]).toLowerCase());
}

function routeOperationKeys(): string[] {
  const keys: string[] = [];
  for (const file of routeFiles()) {
    for (const method of exportedMethods(file)) {
      keys.push(`${method.toUpperCase()} ${toSpecPath(file)}`);
    }
  }
  return keys.sort((a, b) => a.localeCompare(b));
}

function specOperationKeys(spec: ParsedSpec): string[] {
  return spec.operations
    .map((op) => `${op.method.toUpperCase()} ${op.path}`)
    .sort((a, b) => a.localeCompare(b));
}

function opLabel(op: SpecOperation): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

function requirementText(op: SpecOperation): string {
  return [op.securityInline ?? '', ...op.securityBlock].join('\n');
}

function referencedSchemes(op: SpecOperation): string[] {
  return [...requirementText(op).matchAll(/([A-Za-z]\w*):\s*\[/g)].map((match) => match[1]);
}

function appTokenScopes(op: SpecOperation): string[][] {
  return [...requirementText(op).matchAll(/appToken:\s*\[([^\]]*)]/g)].map((match) =>
    match[1]
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
}

const specText = readFileSync(SPEC_FILE, 'utf8');
const spec = parseSpec(specText);

describe('api-spec/openapi.yaml', () => {
  it('is a plain-spaces OpenAPI 3.1 document with a populated paths section', () => {
    expect(specText).toMatch(/^openapi:\s*["']?3\.1\.\d+["']?\s*$/m);
    expect(specText).not.toContain('\t');
    expect(spec.operations.length).toBeGreaterThan(0);
  });

  it('has a path+operation for every exported route method and nothing else', () => {
    const routes = routeOperationKeys();
    const documented = specOperationKeys(spec);

    expect(routes.length).toBeGreaterThan(0);
    const missingFromSpec = routes.filter((key) => !documented.includes(key));
    const missingFromRoutes = documented.filter((key) => !routes.includes(key));

    expect({ missingFromSpec, missingFromRoutes }).toEqual({ missingFromSpec: [], missingFromRoutes: [] });
  });

  it('documents each operation once', () => {
    const keys = specOperationKeys(spec);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every operation a unique operationId', () => {
    const missing = spec.operations.filter((op) => !op.operationId).map(opLabel);
    const ids = spec.operations.map((op) => op.operationId);

    expect(missing).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares a security requirement on every operation, or marks it explicitly public', () => {
    const undeclared = spec.operations.filter((op) => op.securityInline === null).map(opLabel);
    expect(undeclared).toEqual([]);

    const publicOps = spec.operations.filter((op) => op.securityInline === '[]');
    const unmarked = publicOps.filter((op) => !op.xPublic).map(opLabel);
    expect(unmarked).toEqual([]);

    const publicFlagWithAuth = spec.operations
      .filter((op) => op.xPublic && op.securityInline !== '[]')
      .map(opLabel);
    expect(publicFlagWithAuth).toEqual([]);
  });

  it('only references security schemes defined under components.securitySchemes', () => {
    const unknown = spec.operations.flatMap((op) =>
      referencedSchemes(op)
        .filter((name) => !spec.securitySchemes.has(name))
        .map((name) => `${opLabel(op)} -> ${name}`)
    );
    expect(unknown).toEqual([]);
  });

  it('requires events:read on safe methods and events:write otherwise for app tokens', () => {
    const wrong: string[] = [];
    for (const op of spec.operations) {
      const expected = SAFE_METHODS.has(op.method) ? READ_SCOPE : WRITE_SCOPE;
      for (const scopes of appTokenScopes(op)) {
        if (scopes.length !== 1 || scopes[0] !== expected) wrong.push(opLabel(op));
      }
    }
    expect(wrong).toEqual([]);
  });

  it('does not reference kernel-internal auth wording or endpoints', () => {
    expect(specText).not.toMatch(/@imajin\//);
    expect(specText).not.toMatch(/internal[- ]key/i);
  });
});

describe('GET /api/spec', () => {
  it('serves api-spec/openapi.yaml verbatim as text/yaml', async () => {
    const response = await getSpec();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/yaml');
    expect(await response.text()).toBe(specText);
  });
});
