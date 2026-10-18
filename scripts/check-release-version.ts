import { isDeepStrictEqual } from 'node:util'
import { git, object } from './native-inert-result.ts'

const PACKAGES = ['core', 'opencode', 'pi'] as const
const CORE = '@cortexkit/antigravity-auth-core'

function syncedPackage(
  value: unknown,
  name: string,
  version: string,
): Record<string, unknown> {
  const pkg = object(structuredClone(value))
  if (typeof pkg.version !== 'string') throw new Error(`${name} has no version`)
  pkg.version = version
  if (name !== 'core') {
    const deps = object(pkg.dependencies)
    if (typeof deps[CORE] !== 'string')
      throw new Error(`${name} has no core pin`)
    deps[CORE] = version
  }
  return pkg
}

export function checkReleaseVersion(root: string, version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/.test(version))
    throw new Error('invalid release version')
  const parents = git(root, 'rev-list', '--parents', '-n', '1', 'HEAD')
    .trim()
    .split(' ')
  if (parents.length !== 2)
    throw new Error('release HEAD must have exactly one parent')
  if (git(root, 'log', '-1', '--format=%s').trim() !== `release: v${version}`)
    throw new Error(
      `HEAD is not the version-sync commit for ${version}; run ./scripts/release.sh --prepare ${version}`,
    )
  const allowed = new Set([
    'bun.lock',
    ...PACKAGES.map((name) => `packages/${name}/package.json`),
  ])
  const changed = git(root, 'diff', '--name-only', '-z', 'HEAD^', 'HEAD')
    .split('\0')
    .filter(Boolean)
  if (changed.length === 0 || changed.some((path) => !allowed.has(path)))
    throw new Error(
      'version-sync commit changes files outside the manifests and lock',
    )
  const metadata = git(root, 'diff', '--raw', '--no-abbrev', 'HEAD^', 'HEAD')
  if (
    metadata
      .split('\n')
      .filter(Boolean)
      .some((line) => !/^:100644 100644 [a-f0-9]+ [a-f0-9]+ M\t/.test(line))
  )
    throw new Error(
      'version-sync commit must only modify regular files without changing their modes',
    )
  let versionChanged = false
  for (const name of PACKAGES) {
    const path = `packages/${name}/package.json`
    const before: unknown = JSON.parse(git(root, 'show', `HEAD^:${path}`))
    const after: unknown = JSON.parse(git(root, 'show', `HEAD:${path}`))
    const expected = syncedPackage(before, name, version)
    if (!isDeepStrictEqual(before, expected)) versionChanged = true
    if (!isDeepStrictEqual(after, expected))
      throw new Error(`non-version change or wrong version in ${path}`)
  }
  // Bun's text lock is JSON with trailing commas, not strict JSON.
  const before = object(Bun.JSONC.parse(git(root, 'show', 'HEAD^:bun.lock')))
  const original = structuredClone(before)
  const after = object(Bun.JSONC.parse(git(root, 'show', 'HEAD:bun.lock')))
  const workspaces = object(before.workspaces)
  for (const name of PACKAGES) {
    workspaces[`packages/${name}`] = syncedPackage(
      workspaces[`packages/${name}`],
      name,
      version,
    )
  }
  if (!isDeepStrictEqual(after, before))
    throw new Error('non-version change or stale workspace version in bun.lock')
  if (!versionChanged && isDeepStrictEqual(original, before))
    throw new Error('version-sync commit changes no version or core-pin fields')
}

if (import.meta.main) {
  try {
    checkReleaseVersion(process.cwd(), process.argv[2] ?? '')
    console.log(`Verified version-only release commit for ${process.argv[2]}`)
  } catch (error) {
    console.error(
      `Release version check refused: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
