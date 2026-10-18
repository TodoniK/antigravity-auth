import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'

type Value = string | boolean | Value[]

// Interpret only literal registration arguments. Test bodies are never imported
// or evaluated, so this completeness check needs no native job authority.
function registrations(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const constants = new Map<string, ts.Expression>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer)
        constants.set(decl.name.text, decl.initializer)
    }
  }
  function evaluate(expr: ts.Expression, scope: Map<string, Value>): Value {
    if (ts.isStringLiteralLike(expr)) return expr.text
    if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr))
      return evaluate(expr.expression, scope)
    if (ts.isArrayLiteralExpression(expr))
      return expr.elements.map((item) => evaluate(item, scope))
    if (ts.isIdentifier(expr)) {
      const value = scope.get(expr.text)
      if (value !== undefined) return value
      const constant = constants.get(expr.text)
      if (constant) return evaluate(constant, scope)
    }
    if (ts.isTemplateExpression(expr))
      return (
        expr.head.text +
        expr.templateSpans
          .map(
            (span) =>
              String(evaluate(span.expression, scope)) + span.literal.text,
          )
          .join('')
      )
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    )
      return evaluate(expr.left, scope) === evaluate(expr.right, scope)
    if (ts.isConditionalExpression(expr))
      return evaluate(
        evaluate(expr.condition, scope) ? expr.whenTrue : expr.whenFalse,
        scope,
      )
    throw new Error(
      `unsupported static motor registration expression: ${expr.getText(source)}`,
    )
  }
  const names: string[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'motorTest'
    ) {
      const loops: ts.ForOfStatement[] = []
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isForOfStatement(parent)) loops.unshift(parent)
      }
      let scopes = [new Map<string, Value>()]
      for (const loop of loops) {
        const decl = ts.isVariableDeclarationList(loop.initializer)
          ? loop.initializer.declarations[0]
          : undefined
        if (!decl || !ts.isIdentifier(decl.name))
          throw new Error('unsupported motor registration loop')
        const variable = decl.name.text
        scopes = scopes.flatMap((scope) => {
          const values = evaluate(loop.expression, scope)
          if (!Array.isArray(values))
            throw new Error('motor loop must be a literal array')
          return values.map(
            (value) => new Map([...scope, [variable, value] as const]),
          )
        })
      }
      for (const scope of scopes) {
        const [group, name] = node.arguments
        if (!group || !name) throw new Error('motor registration has no name')
        const fullGroup = evaluate(group, scope)
        const fullName = evaluate(name, scope)
        if (typeof fullGroup !== 'string' || typeof fullName !== 'string')
          throw new Error('motor name is not a string')
        names.push(`${fullGroup} > ${fullName}`)
      }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

test('tracked native-inert inventory equals statically expanded motor registrations', () => {
  const root = resolve(import.meta.dir, '..')
  const expected: unknown = JSON.parse(
    readFileSync(
      resolve(root, 'packages/e2e-tests/docker/native-inert-inventory.json'),
      'utf8',
    ),
  )
  const names = [
    'packages/e2e-tests/docker/ga-contract-inputs.test.ts',
    'packages/e2e-tests/src/opencode-ga-harness.test.ts',
    'packages/e2e-tests/src/opencode-ga-inputs.test.ts',
  ].flatMap((path) => registrations(resolve(root, path)))
  expect(Array.isArray(expected)).toBe(true)
  expect(expected).toHaveLength(41)
  expect(new Set(names).size).toBe(41)
  expect(names.sort()).toEqual((expected as string[]).sort())
})
