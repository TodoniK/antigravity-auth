import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { STATUS_CODES } from 'node:http'
import { runInNewContext } from 'node:vm'
import { preResponseTimeoutResponse } from '@cortexkit/antigravity-auth-core'

const sourceRoot = new URL(
  '../../../../research/v1-unmigrated-upgrade/official-retry-source/',
  import.meta.url,
)

function officialModule(
  filename: string,
  bindings: Record<string, unknown>,
  result: string,
): unknown {
  const source = readFileSync(new URL(filename, sourceRoot), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace(/^export \* as .*\n/gm, '')
    .replace(/^export /gm, '')
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  return runInNewContext(`${compiled}\n;(${result})`, bindings)
}

type HostError = { name: string; data: Record<string, unknown> }

describe('official OpenCode refusal retry policy', () => {
  it('OpenCode 1.17.13 own retry policy does not retry the pre-response 412', async () => {
    const inventory = JSON.parse(
      readFileSync(new URL('inventory.json', sourceRoot), 'utf8'),
    ) as Array<{ filename: string; bytes: number; sha256: string }>
    expect(inventory).toHaveLength(3)
    for (const entry of inventory) {
      const bytes = readFileSync(new URL(entry.filename, sourceRoot))
      expect(bytes.length).toBe(entry.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        entry.sha256,
      )
    }
    const iife = (fn: () => unknown) => fn()
    const retryable = officialModule(
      'retry.ts.txt',
      {
        SessionV1: {
          ContextOverflowError: {
            isInstance: (error: HostError) =>
              error.name === 'ContextOverflowError',
          },
          APIError: {
            isInstance: (error: HostError) => error.name === 'APIError',
          },
        },
        iife,
        isRecord: (value: unknown) =>
          value !== null && typeof value === 'object',
      },
      'retryable',
    ) as (error: HostError, provider: string) => unknown
    const parse = officialModule(
      'error.ts.txt',
      {
        STATUS_CODES,
        iife,
        isContextOverflow: () => false,
      },
      'parseAPICallError',
    ) as (input: {
      providerID: string
      error: Record<string, unknown>
    }) => Record<string, unknown>

    const refusal = preResponseTimeoutResponse()
    const body = await refusal.text()
    expect(body).not.toMatch(/429|500|502|503|504|524/)
    expect(refusal.headers.has('retry-after')).toBe(false)
    const parsed = parse({
      providerID: 'google',
      error: {
        message: STATUS_CODES[refusal.status],
        statusCode: refusal.status,
        responseBody: body,
        isRetryable: false,
      },
    })
    const api: HostError = { name: 'APIError', data: parsed }
    let executions = 0
    do {
      executions++
    } while (retryable(api, 'google') && executions < 3)
    expect(executions).toBe(1)
    // Also execute the host's plain-text scan, not just its API status branch.
    expect(
      retryable({ name: 'UnknownError', data: { message: body } }, 'google'),
    ).toBeUndefined()
    expect(
      retryable(
        { name: 'UnknownError', data: { message: 'rate limit' } },
        'google',
      ),
    ).toBeTruthy()
    expect(
      retryable(
        { name: 'UnknownError', data: { message: '{"code":"unavailable"}' } },
        'google',
      ),
    ).toBeTruthy()
    expect(
      retryable({ ...api, data: { ...parsed, statusCode: 503 } }, 'google'),
    ).toBeTruthy()
    expect(
      retryable({ ...api, data: { ...parsed, isRetryable: true } }, 'google'),
    ).toBeTruthy()
  })
})
