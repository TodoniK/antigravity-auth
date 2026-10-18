import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  RECORD_PATH,
  RESULT_PREFIX,
  sha256,
  validateResult,
} from './native-inert-result.ts'

export function recordNativeInertGate(
  stdoutPath: string,
  root = process.cwd(),
): void {
  const record = join(root, RECORD_PATH)
  const temporary = `${record}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const raw = readFileSync(stdoutPath)
    const lines = raw
      .toString('utf8')
      .split('\n')
      .filter((line) => line.startsWith(RESULT_PREFIX))
    if (lines.length !== 1)
      throw new Error('expected exactly one NATIVE_INERT_GATE_RESULT line')
    const result = validateResult(
      JSON.parse((lines[0] ?? '').slice(RESULT_PREFIX.length)),
      root,
    )
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(
      temporary,
      `${JSON.stringify({ ...result, stdoutSha256: sha256(raw) }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' },
    )
    renameSync(temporary, record)
    console.log(`Wrote ${RECORD_PATH} for ${result.commit}`)
  } catch (error) {
    // A failed or interrupted attempt invalidates even an older passing record.
    rmSync(record, { force: true })
    throw error
  } finally {
    rmSync(temporary, { force: true })
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || !process.argv[2])
      throw new Error(
        'Usage: bun scripts/record-native-inert-gate.ts <saved-io/stdout>',
      )
    recordNativeInertGate(process.argv[2])
  } catch (error) {
    rmSync(join(process.cwd(), RECORD_PATH), { force: true })
    console.error(
      `Native-inert record refused: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
