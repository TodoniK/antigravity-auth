import { afterEach, expect, test } from 'bun:test'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '..')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (result.exitCode) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  for (const file of ['release.sh', 'version-sync.mjs', 'sync-release-lock.ts'])
    cpSync(join(sourceRoot, 'scripts', file), join(root, 'scripts', file))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, workspaces: ['packages/*'] }),
  )
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  for (const name of ['core', 'opencode', 'pi']) {
    mkdirSync(join(root, 'packages', name), { recursive: true })
    const pkg = {
      name:
        name === 'core'
          ? '@cortexkit/antigravity-auth-core'
          : `@example/${name}`,
      version: '1.0.0',
      description: 'unchanged',
      ...(name === 'core'
        ? {}
        : { dependencies: { '@cortexkit/antigravity-auth-core': '1.0.0' } }),
    }
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify(pkg),
    )
  }
  const installed = Bun.spawnSync(
    [
      process.execPath,
      'install',
      '--lockfile-only',
      '--ignore-scripts',
      '--offline',
    ],
    { cwd: root },
  )
  if (installed.exitCode) throw new Error(installed.stderr.toString())
  symlinkSync(
    join(sourceRoot, 'node_modules'),
    join(root, 'node_modules'),
    'dir',
  )
  git(root, 'init', '-b', 'main')
  git(root, 'config', 'user.name', 'Release Test')
  git(root, 'config', 'user.email', 'release@example.invalid')
  git(root, 'config', 'core.hooksPath', '/dev/null')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'fixture')
  return root
}

function bump(root: string, corrupt?: string) {
  for (const name of ['core', 'opencode', 'pi']) {
    const path = join(root, 'packages', name, 'package.json')
    const pkg = JSON.parse(readFileSync(path, 'utf8'))
    pkg.version = '1.0.1'
    if (pkg.dependencies)
      pkg.dependencies['@cortexkit/antigravity-auth-core'] = '1.0.1'
    if (name === 'core' && corrupt === 'manifest')
      pkg.description = 'smuggled change'
    writeFileSync(path, JSON.stringify(pkg))
  }
  const lockPath = join(root, 'bun.lock')
  const lock = Bun.JSONC.parse(readFileSync(lockPath, 'utf8')) as {
    workspaces: Record<
      string,
      { version?: string; dependencies?: Record<string, string> }
    >
    packages: Record<string, unknown>
  }
  for (const [path, pkg] of Object.entries(lock.workspaces)) {
    if (!path.startsWith('packages/')) continue
    pkg.version = '1.0.1'
    if (pkg.dependencies)
      pkg.dependencies['@cortexkit/antigravity-auth-core'] = '1.0.1'
  }
  if (corrupt === 'lock') lock.packages.injected = ['unexpected']
  writeFileSync(lockPath, JSON.stringify(lock))
  if (corrupt === 'source')
    writeFileSync(join(root, 'source.ts'), 'export const smuggled = true\n')
  git(root, 'add', '.')
  git(
    root,
    'commit',
    '-m',
    corrupt === 'subject' ? 'not a version sync' : 'release: v1.0.1',
  )
}

for (const state of [
  'valid',
  'manifest',
  'lock',
  'source',
  'subject',
] as const) {
  test(`release version-sync check handles ${state}`, () => {
    const root = fixture()
    bump(root, state)
    const checked = Bun.spawnSync(
      [
        process.execPath,
        join(sourceRoot, 'scripts/check-release-version.ts'),
        '1.0.1',
      ],
      { cwd: root },
    )
    expect(checked.exitCode === 0, checked.stderr.toString()).toBe(
      state === 'valid',
    )
  })
}

test('release --prepare commits versions without a tag or gate', () => {
  const root = fixture()
  const prepared = Bun.spawnSync(
    ['bash', 'scripts/release.sh', '--prepare', '1.0.1'],
    { cwd: root },
  )
  expect(prepared.exitCode, prepared.stderr.toString()).toBe(0)
  expect(git(root, 'log', '-1', '--format=%s')).toBe('release: v1.0.1')
  expect(git(root, 'tag', '--list')).toBe('')
  expect(git(root, 'status', '--porcelain')).toBe('')
  expect(prepared.stdout.toString()).not.toContain('Running pre-release checks')
  expect(prepared.stdout.toString()).not.toContain('Creating tag')
  const checked = Bun.spawnSync(
    [
      process.execPath,
      join(sourceRoot, 'scripts/check-release-version.ts'),
      '1.0.1',
    ],
    { cwd: root },
  )
  expect(
    checked.exitCode,
    `${checked.stderr}\n${git(root, 'diff', 'HEAD^', 'HEAD', '--', 'bun.lock')}`,
  ).toBe(0)
})
