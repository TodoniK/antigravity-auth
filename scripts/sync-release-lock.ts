import { readFileSync, writeFileSync } from 'node:fs'
import * as ts from 'typescript'

const version = process.argv[2] ?? ''
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/.test(version))
  throw new Error('expected a release version')
const path = 'bun.lock'
const raw = readFileSync(path, 'utf8')
const source = ts.parseJsonText(path, raw)
const statement = source.statements[0]
if (!statement || !ts.isExpressionStatement(statement))
  throw new Error('invalid Bun lock')

function property(node: ts.Expression, key: string): ts.Expression {
  if (!ts.isObjectLiteralExpression(node))
    throw new Error(`lock object missing for ${key}`)
  const entry = node.properties.find(
    (item) =>
      ts.isPropertyAssignment(item) &&
      (ts.isStringLiteral(item.name) || ts.isIdentifier(item.name)) &&
      item.name.text === key,
  )
  if (!entry || !ts.isPropertyAssignment(entry))
    throw new Error(`lock field missing: ${key}`)
  return entry.initializer
}

const workspaces = property(statement.expression, 'workspaces')
const replacements: Array<{ start: number; end: number }> = []
for (const name of ['core', 'opencode', 'pi']) {
  const pkg = property(workspaces, `packages/${name}`)
  const fields = [property(pkg, 'version')]
  if (name !== 'core')
    fields.push(
      property(
        property(pkg, 'dependencies'),
        '@cortexkit/antigravity-auth-core',
      ),
    )
  for (const field of fields) {
    if (!ts.isStringLiteral(field))
      throw new Error('lock version/core pin must be a string')
    replacements.push({ start: field.getStart(source), end: field.end })
  }
}
// Edit parsed value spans so resolution data and lock formatting remain intact.
let updated = raw
for (const { start, end } of replacements.sort((a, b) => b.start - a.start))
  updated =
    updated.slice(0, start) + JSON.stringify(version) + updated.slice(end)
Bun.JSONC.parse(updated)
if (updated !== raw) writeFileSync(path, updated)
console.log(`Synced five lock workspace version/core-pin fields to ${version}`)
