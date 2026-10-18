import { checkReleaseRecord, GATE_INSTRUCTIONS } from './native-inert-result.ts'

try {
  const result = checkReleaseRecord(process.cwd())
  console.log(
    `Native-inert gate passed on exact release commit ${result.commit}`,
  )
} catch (error) {
  console.error(
    `Native-inert release gate refused: ${error instanceof Error ? error.message : String(error)}\n${GATE_INSTRUCTIONS}`,
  )
  process.exitCode = 1
}
