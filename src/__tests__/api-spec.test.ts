/**
 * api-spec accuracy (#2515): `api-spec/openapi.yaml` is the contract this app
 * serves at /api/spec, so it must describe exactly the routes that exist —
 * every route handler documented, every documented operation implemented —
 * and be internally consistent ($refs resolve, operationIds unique).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

const ROOT = process.cwd();
const API_DIR = join(ROOT, 'app', 'api');
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
}
type PathItem = Partial<Record<(typeof HTTP_METHODS)[number], Operation>>;
interface Spec {
  paths: Record<string, PathItem>;
  components: Record<string, Record<string, unknown>>;
}

const specText = readFileSync(join(ROOT, 'api-spec', 'openapi.yaml'), 'utf-8');
const spec = parse(specText) as Spec;

function routeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === '__tests__') continue;
    if (statSync(full).isDirectory()) {
      files.push(...routeFiles(full));
    } else if (entry === 'route.ts') {
      files.push(full);
    }
  }
  return files;
}

/** `app/api/events/[id]/route.ts` → `/api/events/{id}` */
function specPathFor(file: string): string {
  const dir = relative(ROOT, file).split(sep).slice(1, -1).join('/');
  return `/${dir}`.replaceAll(/\[\.\.\.(\w+)\]/g, '{$1}').replaceAll(/\[(\w+)\]/g, '{$1}');
}

function exportedMethods(file: string): string[] {
  const source = readFileSync(file, 'utf-8');
  const found = new Set<string>();
  for (const match of source.matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)) {
    found.add(match[1].toLowerCase());
  }
  return [...found].sort();
}

const routes = new Map(routeFiles(API_DIR).map((f) => [specPathFor(f), exportedMethods(f)]));

/** Param names differ between folder names and the spec (`{id}` vs `{ticketId}`); compare by shape. */
const shape = (p: string) => p.replaceAll(/\{[^}]+\}/g, '{}');

describe('api-spec/openapi.yaml', () => {
  const specByShape = new Map(Object.entries(spec.paths).map(([p, item]) => [shape(p), item]));

  it('documents every route handler', () => {
    const undocumented = [...routes.keys()].filter((p) => !specByShape.has(shape(p)));
    expect(undocumented).toEqual([]);
  });

  it('documents no path that has no route handler', () => {
    const routeShapes = new Set([...routes.keys()].map(shape));
    const stale = Object.keys(spec.paths).filter((p) => !routeShapes.has(shape(p)));
    expect(stale).toEqual([]);
  });

  it('documents exactly the HTTP methods each route exports', () => {
    const mismatched: string[] = [];
    for (const [path, methods] of routes) {
      const item = specByShape.get(shape(path)) ?? {};
      const documented = HTTP_METHODS.filter((m) => item[m]).sort();
      if (documented.join() !== methods.join()) {
        mismatched.push(`${path}: spec [${documented}] vs route [${methods}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('resolves every $ref and keeps operationIds unique', () => {
    for (const [, section, name] of specText.matchAll(/#\/components\/(\w+)\/(\w+)/g)) {
      expect(spec.components[section], `components.${section}`).toHaveProperty(name);
    }
    const ids = Object.values(spec.paths).flatMap((item) =>
      HTTP_METHODS.flatMap((m) => (item[m]?.operationId ? [item[m]!.operationId!] : [])),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares only security schemes that exist', () => {
    const schemes = Object.keys(spec.components.securitySchemes);
    const used = new Set(
      Object.values(spec.paths).flatMap((item) =>
        HTTP_METHODS.flatMap((m) => (item[m]?.security ?? []).flatMap((req) => Object.keys(req))),
      ),
    );
    expect([...used].filter((s) => !schemes.includes(s))).toEqual([]);
  });
});
