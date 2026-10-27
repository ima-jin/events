import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Inspect browser URL sinks, not route documentation or already-prefixing helper callers. */
function rawApiUrls(source: string): string[] {
  const file = ts.createSourceFile('client.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures: string[] = [];
  const variables = new Map<string, ts.Expression>();
  function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      variables.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);

  function isRaw(node: ts.Node | undefined, seen = new Set<string>()): boolean {
    if (!node) return false;
    if (ts.isStringLiteralLike(node)) return node.text.startsWith('/api/');
    if (ts.isTemplateExpression(node)) return node.head.text.startsWith('/api/');
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      seen.add(node.text);
      return isRaw(variables.get(node.text), seen);
    }
    if (ts.isParenthesizedExpression(node) || ts.isJsxExpression(node)) return isRaw(node.expression, seen);
    if (ts.isConditionalExpression(node)) return isRaw(node.whenTrue, seen) || isRaw(node.whenFalse, seen);
    return false;
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && /^(?:globalThis\.)?fetch$/.test(node.expression.getText(file))
      && isRaw(node.arguments[0])) {
      failures.push(node.getText(file));
    }
    if (ts.isJsxAttribute(node) && ['href', 'action'].includes(node.name.getText(file))
      && isRaw(node.initializer)) {
      failures.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return failures;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === '__tests__') return [];
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('client API basePath guard', () => {
  it.each([
    "fetch('/api/auth/session')",
    'fetch(`/api/tickets/${id}/qr`)',
    '<a href="/api/export">Export</a>',
    '<form action={"/api/auth/logout"} />',
    "const path = '/api/auth/session'; globalThis.fetch(path)",
    "const path = ready ? `/api/tickets/${id}/qr` : null; fetch(path)",
  ])('rejects an unprefixed browser URL: %s', (source) => {
    expect(rawApiUrls(source)).toHaveLength(1);
  });

  it('allows withBasePath and helper calls that prefix internally', () => {
    expect(rawApiUrls(`
      fetch(withBasePath('/api/auth/session'));
      <a href={withBasePath('/api/export')}>Export</a>;
      <form action={withBasePath('/api/auth/logout')} />;
      campaignRequest('/api/campaign/pledge');
      readJson('/api/tickets/one/qr');
    `)).toEqual([]);
  });

  it('has no raw API URLs in client components, hooks, or their API helpers', () => {
    const root = process.cwd();
    const files = [
      ...sourceFiles(join(root, 'src/components')),
      ...sourceFiles(join(root, 'src/hooks')),
      ...sourceFiles(join(root, 'app')).filter((path) => {
        return /^\s*['"]use client['"]/.test(readFileSync(path, 'utf8'));
      }),
    ];
    const failures = files.flatMap((path) => rawApiUrls(readFileSync(path, 'utf8'))
      .map((source) => `${relative(root, path)}: ${source}`));
    expect(failures).toEqual([]);
  });
});
