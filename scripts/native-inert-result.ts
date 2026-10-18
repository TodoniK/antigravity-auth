import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const INVENTORY_PATH =
  'packages/e2e-tests/docker/native-inert-inventory.json'
export const RECORD_PATH = '.cortexkit/release-gates/native-inert.json'
export const RESULT_PREFIX = 'NATIVE_INERT_GATE_RESULT='
export const STAGE_NAMES = [
  'bun-version',
  'typescript-version',
  'biome-version',
  'core-build',
  'strict-ga',
  'strict-scripts',
  'scoped-biome-check',
  'portable-suite',
  'motor-suite',
] as const

export interface GateResult {
  schemaVersion: 1
  commit: string
  tree: string
  pass: boolean
  stages: Array<{ name: string; exit: number }>
  names: string[]
  inventorySha256: string
  motor: { pass: number; fail: number; assertions: number }
  bunVersion: string
  startedUtc: string
  endedUtc: string
  failingStage?: string
  error?: string
}

export function sha256(raw: string | Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: root,
    },
    timeout: 10_000,
  })
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.toString()
}

export function sameNames(
  actual: unknown,
  expected: string[],
): actual is string[] {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((name) => typeof name === 'string') &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  )
}

export function inventory(raw: string): string[] {
  const names: unknown = JSON.parse(raw)
  if (
    !Array.isArray(names) ||
    names.length !== 41 ||
    !names.every((name) => typeof name === 'string' && name.length > 0) ||
    new Set(names).size !== 41
  )
    throw new Error('inventory must contain 41 unique names')
  return names
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected an object')
  return value as Record<string, unknown>
}

export function validateResult(value: unknown, root: string): GateResult {
  const result = object(value)
  if (result.schemaVersion !== 1)
    throw new Error('unsupported native-inert schema')
  if (result.pass !== true) throw new Error('native-inert gate did not pass')
  if (
    typeof result.commit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(result.commit)
  )
    throw new Error('invalid commit')
  const commit = git(
    root,
    'rev-parse',
    '--verify',
    `${result.commit}^{commit}`,
  ).trim()
  if (commit !== result.commit) throw new Error('commit identity mismatch')
  if (result.tree !== git(root, 'rev-parse', `${commit}^{tree}`).trim())
    throw new Error('tree identity mismatch')
  const raw = git(root, 'show', `${commit}:${INVENTORY_PATH}`)
  const names = inventory(raw)
  if (!sameNames(result.names, names))
    throw new Error('native-inert names differ from committed inventory')
  if (result.inventorySha256 !== sha256(raw))
    throw new Error('inventory hash mismatch')
  if (
    !Array.isArray(result.stages) ||
    result.stages.length !== STAGE_NAMES.length ||
    !result.stages.every((stage, i) => {
      const row = object(stage)
      return row.name === STAGE_NAMES[i] && row.exit === 0
    })
  )
    throw new Error('all nine stages must exit zero in order')
  const motor = object(result.motor)
  if (
    !Number.isSafeInteger(motor.pass) ||
    (motor.pass as number) < 41 ||
    motor.fail !== 0 ||
    !Number.isSafeInteger(motor.assertions) ||
    (motor.assertions as number) < 41
  )
    throw new Error('invalid motor counts')
  if (
    typeof result.bunVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(result.bunVersion)
  )
    throw new Error('invalid Bun version')
  const times = [result.startedUtc, result.endedUtc]
  if (
    !times.every(
      (time) =>
        typeof time === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time) &&
        Number.isFinite(Date.parse(time)) &&
        new Date(time).toISOString() === time,
    ) ||
    Date.parse(String(result.endedUtc)) < Date.parse(String(result.startedUtc))
  )
    throw new Error('invalid UTC times')
  if (result.failingStage !== undefined || result.error !== undefined)
    throw new Error('passing result contains a failure')
  return result as unknown as GateResult
}

export function checkReleaseRecord(root: string): GateResult {
  const value = object(
    JSON.parse(readFileSync(join(root, RECORD_PATH), 'utf8')),
  )
  const result = validateResult(value, root)
  if (result.commit !== git(root, 'rev-parse', 'HEAD').trim())
    throw new Error('gate commit is not the exact release HEAD')
  if (
    typeof value.stdoutSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.stdoutSha256)
  )
    throw new Error('record lacks stdout hash')
  const raw = readFileSync(join(root, INVENTORY_PATH), 'utf8')
  if (
    sha256(raw) !== result.inventorySha256 ||
    !sameNames(result.names, inventory(raw))
  )
    throw new Error('working inventory differs from gate')
  return result
}

export const GATE_INSTRUCTIONS = `Run the gate on the prepared, clean release commit through AFT, then save that task's io/stdout locally:
functions.bash({command: "bun run test:native-inert", runon: "linux,2c", timeout: 900000, wait: true})
bun scripts/record-native-inert-gate.ts <saved-io/stdout>
Then re-run ./scripts/release.sh <version>.`
