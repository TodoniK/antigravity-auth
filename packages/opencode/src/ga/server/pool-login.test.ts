import { describe, expect, it, spyOn } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountRepository,
  createAccountMigrationFactory,
  loadCommonAuthStoreModules,
  readAccountStoreBinding,
} from '@cortexkit/antigravity-auth-core'
import type {
  IntegrationEditor,
  IntegrationMethodRegistration,
} from '@opencode/plugin/promise/integration'
import {
  createGaLocationServicesFactory,
  createGaReauthorize,
  createGaRuntimeCollaborators,
} from '../../plugin/ga-location-services.ts'
import { createOperatorSettingsRegistry } from '../../plugin/operator-settings.ts'
import * as persistence from '../../plugin/persist-account-pool.ts'
import {
  createLocationRuntime,
  type LocationRuntime,
} from '../../plugin/shared/runtime.ts'
import * as storage from '../../plugin/storage.ts'
import { registerGaAuthMethods } from './auth.ts'
import type { GaLocationServices } from './index.ts'
import { GA_POOL_METHOD_ID } from './pool-login.ts'

function tree(root: string) {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((path) => {
      const full = join(root, path)
      return [
        path,
        statSync(full).isDirectory()
          ? 'directory'
          : readFileSync(full).toString('base64'),
      ]
    })
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ga-pool-login-'))
  const previous = {
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.OPENCODE_CONFIG_DIR = join(root, 'global-config')
  process.env.XDG_CONFIG_HOME = join(root, 'xdg')
  const legacyPath = join(root, 'resolved', 'accounts.json')
  const modules = await loadCommonAuthStoreModules()
  let mode: 'local' | 'custody' | 'unreadable' = 'local'
  let getRepository: (() => Promise<AccountRepository>) | undefined
  let services: GaLocationServices | undefined
  let runtime: LocationRuntime | undefined
  let registration:
    | Awaited<ReturnType<typeof registerGaAuthMethods>>
    | undefined
  let result = {
    type: 'success' as const,
    refresh: 'pool-refresh|pool-project',
    access: 'pool-access',
    expires: Date.now() + 3_600_000,
    email: 'pool@example.test',
    projectId: 'pool-project',
  }
  let refreshes = 0
  const selected: string[][] = []
  const factory = createGaLocationServicesFactory({
    resolveAccountFile: () => legacyPath,
    loadStoreModules: async () => modules,
    now: Date.now,
    runtime: (input) => {
      getRepository = input.getRepository
      return createGaRuntimeCollaborators({
        ...input,
        accounts: { current: null, quotaLogger: null },
        now: Date.now,
      })
    },
    createPipeline: async ({ repository }) => ({
      execute: async () => {
        const read = await repository.read()
        if (read.status !== 'ready') throw new Error(read.status)
        selected.push(
          read.rows.map((row) => row.credential?.refreshToken ?? ''),
        )
        return new Response('next request uses committed account')
      },
      refreshAccounts: async () => {
        refreshes++
      },
      dispose: async () => {},
    }),
    custody: () => ({
      readMode: async () =>
        mode === 'unreadable'
          ? { ok: false, reason: 'unreadable' }
          : { ok: true, record: { version: 1, mode } },
      custodySource: async () => {
        throw new Error('Vault acquisition is not part of local login')
      },
      readState: async () => ({ schemaVersion: 1, accounts: {} }),
      menuSection: () => ({
        id: 'vault',
        title: 'Vault',
        build: () => ({ lines: [], actions: [] }),
      }),
      dispose: async () => {},
    }),
  })
  const methods: IntegrationMethodRegistration[] = []
  const editor: IntegrationEditor = {
    list: () => [{ id: 'google', name: 'Google' }],
    get: () => ({ id: 'google', name: 'Google' }),
    update: () => {
      throw new Error('Native metadata must stay unchanged')
    },
    remove: () => {
      throw new Error('Native integrations must stay unchanged')
    },
    method: {
      list: () => [],
      update: (method) => {
        methods.push(method)
      },
      remove: () => {
        throw new Error('Native methods must stay unchanged')
      },
    },
  }
  const cleanup = async () => {
    try {
      await registration?.dispose()
      await services?.dispose()
      await runtime?.dispose()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
  try {
    services = await factory({ directory: root, overrides: {} })
    registration = await registerGaAuthMethods(
      {
        integration: {
          transform: async (transform) => {
            transform(editor)
            return { dispose: async () => {} }
          },
        },
      },
      undefined,
      {
        local: services.localLogin,
        oauth: {
          waitForCode: async () => 'code',
          exchange: async () => result,
        },
      },
    )
    return {
      root,
      legacyPath,
      modules,
      services,
      registration,
      selected,
      refreshes: () => refreshes,
      mode: (value: typeof mode) => {
        mode = value
      },
      result: (value: Partial<typeof result>) => {
        result = { ...result, ...value }
      },
      repository: async () => {
        if (!getRepository) throw new Error('Repository accessor missing')
        return getRepository()
      },
      login: async () => {
        const method = methods.find(
          ({ method }) =>
            method.type === 'oauth' && method.id === GA_POOL_METHOD_ID,
        )
        if (!method || !('authorize' in method))
          throw new Error('Pool method missing')
        const authorization = await method.authorize({})
        if (authorization.mode !== 'auto')
          throw new Error('Expected auto pool login')
        return authorization.callback
      },
      start: async () => {
        if (!services) throw new Error('Location missing')
        mkdirSync(join(root, '.opencode'), { recursive: true })
        writeFileSync(
          join(root, '.opencode', 'antigravity.json'),
          JSON.stringify({
            background_quota_refresh: false,
            proactive_token_refresh: false,
          }),
        )
        runtime = await createLocationRuntime({
          ...services.runtime,
          directory: root,
          operatorSettingsRegistry: createOperatorSettingsRegistry(),
        })
        return services.start({
          runtime,
          generation: 'pool-login',
          send: async () => {
            throw new Error('No live network')
          },
          notify: () => null,
          isConnected: () => false,
        })
      },
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

async function rows(f: Awaited<ReturnType<typeof fixture>>) {
  const read = await (await f.repository()).read()
  if (read.status !== 'ready') throw new Error(read.status)
  return read.rows
}

const FAILED = 'The Antigravity pool login could not be completed.'

describe('GA location pool login', () => {
  it('initializes only the injected resolved path and the next request sees the committed account without restart', async () => {
    const f = await fixture()
    try {
      const globalPath = storage.getStoragePath()
      expect(globalPath).not.toBe(f.legacyPath)
      expect(
        (await readAccountStoreBinding(f.legacyPath, f.modules, Date.now))
          .status,
      ).toBe('initialization-required')
      const serving = await f.start()
      await expect(
        serving.execute(
          {
            sessionID: 'empty',
            parentSessionID: null,
            kind: 'generate',
            modelID: 'antigravity-gemini-3.5-flash',
            variant: null,
            url: 'https://example.test',
            body: '{}',
          },
          {
            signal: new AbortController().signal,
            send: async () => new Response('unused'),
          },
        ),
      ).rejects.toThrow('not initialized')
      const credential = await f.login()
      expect(String(credential.methodID)).toBe(GA_POOL_METHOD_ID)
      expect(credential.access).not.toBe('pool-access')
      expect(
        (await readAccountStoreBinding(f.legacyPath, f.modules, Date.now))
          .status,
      ).toBe('bound')
      expect(existsSync(globalPath)).toBe(false)
      expect(
        (await readAccountStoreBinding(globalPath, f.modules, Date.now)).status,
      ).toBe('initialization-required')
      expect(
        (await rows(f)).map((row) => row.credential?.refreshToken),
      ).toEqual(['pool-refresh'])
      await serving.execute(
        {
          sessionID: 'next',
          parentSessionID: null,
          kind: 'generate',
          modelID: 'antigravity-gemini-3.5-flash',
          variant: null,
          url: 'https://example.test',
          body: '{}',
        },
        {
          signal: new AbortController().signal,
          send: async () => new Response('unused'),
        },
      )
      expect(f.selected).toEqual([['pool-refresh']])
    } finally {
      await f.cleanup()
    }
  })

  it('refuses a pending migration without initialization or any file writes', async () => {
    const f = await fixture()
    try {
      mkdirSync(join(f.root, 'resolved'), { recursive: true, mode: 0o700 })
      writeFileSync(
        f.legacyPath,
        JSON.stringify({
          version: 4,
          accounts: [
            {
              refreshToken: 'pending-refresh',
              addedAt: 1,
              lastUsed: 2,
            },
          ],
          activeIndex: 0,
        }),
        { mode: 0o600 },
      )
      await expect(
        createAccountMigrationFactory(f.modules)({
          legacyPath: f.legacyPath,
          offline: { processesStopped: true },
          now: Date.now,
          onBoundary: async (name) => {
            if (name === 'after-capture')
              throw new Error('synthetic interruption')
          },
        }),
      ).rejects.toThrow('synthetic interruption')
      expect(
        await readAccountStoreBinding(f.legacyPath, f.modules, Date.now),
      ).toMatchObject({ status: 'pending', phase: 'capture' })
      const before = tree(join(f.root, 'resolved'))
      const initializer = spyOn(storage, 'initializeFreshAccountStoreFor')
      try {
        await expect(f.login()).rejects.toThrow(FAILED)
        expect(initializer).not.toHaveBeenCalled()
        expect(tree(join(f.root, 'resolved'))).toEqual(before)
      } finally {
        initializer.mockRestore()
      }
    } finally {
      await f.cleanup()
    }
  })
})

describe('GA pool login durability', () => {
  for (const mode of ['custody', 'unreadable'] as const) {
    it(`refuses actual ${mode} location authority without creating files`, async () => {
      const f = await fixture()
      try {
        f.mode(mode)
        const before = tree(f.root)
        await expect(f.login()).rejects.toThrow(FAILED)
        expect(tree(f.root)).toEqual(before)
      } finally {
        await f.cleanup()
      }
    })
  }

  it('keeps an initialized bound empty store when authority is revoked before account commit', async () => {
    const f = await fixture()
    const initialize = storage.initializeFreshAccountStoreFor
    const initializer = spyOn(
      storage,
      'initializeFreshAccountStoreFor',
    ).mockImplementation(async (...args) => {
      const outcome = await initialize(...args)
      f.mode('custody')
      return outcome
    })
    try {
      await expect(f.login()).rejects.toThrow(FAILED)
      expect(initializer).toHaveBeenCalledTimes(1)
      expect(initializer.mock.calls[0]?.[1]?.legacyPath).toBe(f.legacyPath)
      expect(
        (await readAccountStoreBinding(f.legacyPath, f.modules, Date.now))
          .status,
      ).toBe('bound')
      f.mode('local')
      expect(await rows(f)).toEqual([])
      await f.login()
      expect(initializer).toHaveBeenCalledTimes(1)
      expect(await rows(f)).toHaveLength(1)
    } finally {
      initializer.mockRestore()
      await f.cleanup()
    }
  })

  for (const action of ['revoke', 'dispose'] as const) {
    it(`retains the committed row without a placeholder when ${action} happens after commit`, async () => {
      const f = await fixture()
      const committed = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const commit = persistence.commitLogins
      const writer = spyOn(persistence, 'commitLogins').mockImplementation(
        async (...args) => {
          const result = await commit(...args)
          expect(result.map((entry) => entry.status)).toEqual(['committed'])
          committed.resolve()
          await release.promise
          return result
        },
      )
      try {
        const pending = f.login().then(
          () => 'unexpected placeholder',
          (error: Error) => error.message,
        )
        await committed.promise
        expect(await rows(f)).toHaveLength(1)
        let disposal: Promise<void> | undefined
        if (action === 'revoke') f.mode('custody')
        else disposal = f.registration.dispose()
        release.resolve()
        expect(await pending).toBe(FAILED)
        await disposal
        f.mode('local')
        expect(
          (await rows(f)).map((row) => row.credential?.refreshToken),
        ).toEqual(['pool-refresh'])
      } finally {
        release.resolve()
        writer.mockRestore()
        await f.cleanup()
      }
    })
  }

  it('rejects a duplicate identity through the registered method and preserves its existing row', async () => {
    const f = await fixture()
    try {
      await f.login()
      const before = await rows(f)
      const bytes = tree(join(f.root, 'resolved'))
      f.result({
        refresh: 'different-secret|pool-project',
        access: 'different-access',
      })
      await expect(f.login()).rejects.toThrow(FAILED)
      expect(await rows(f)).toEqual(before)
      expect(tree(join(f.root, 'resolved'))).toEqual(bytes)
    } finally {
      await f.cleanup()
    }
  })

  it('keeps expected-ref reauthorization distinct from pool add and replaces only the captured row', async () => {
    const f = await fixture()
    let reauthorize: ReturnType<typeof createGaReauthorize> | undefined
    try {
      await f.login()
      f.result({
        refresh: 'second-refresh|pool-project',
        email: 'second@example.test',
      })
      await f.login()
      const before = await rows(f)
      const first = before[0]!
      const changed = Promise.withResolvers<void>()
      const notified = Promise.withResolvers<string>()
      reauthorize = createGaReauthorize({
        repository: await f.repository(),
        assertAdmission: f.services.localLogin!.assertAdmission,
        overrides: {
          oauth: {
            waitForCode: async () => 'code',
            exchange: async () => ({
              type: 'success',
              refresh: 'replacement-refresh|pool-project',
              access: 'replacement-access',
              email: 'pool@example.test',
              expires: Date.now() + 3_600_000,
              projectId: 'pool-project',
            }),
          },
        },
        afterChange: async () => {
          changed.resolve()
        },
      })
      await reauthorize.run(first.ref, {
        notify: (text) => {
          notified.resolve(text)
        },
      })
      expect(await notified.promise).toBe('Account reauthorized.')
      await changed.promise
      await reauthorize.dispose()
      const after = await rows(f)
      expect(after).toHaveLength(2)
      expect(after[0]?.ref.id).toBe(first.ref.id)
      expect(after[0]?.credential?.refreshToken).toBe('replacement-refresh')
      expect(after[1]).toEqual(before[1])
    } finally {
      await reauthorize?.dispose()
      await f.cleanup()
    }
  })

  for (const outcome of ['skipped', 'refused', 'empty', 'multiple'] as const) {
    it(`does not issue a placeholder for a ${outcome} commit result`, async () => {
      const f = await fixture()
      const commit = persistence.commitLogins
      const writer = spyOn(persistence, 'commitLogins').mockImplementation(
        async (...args) => {
          if (outcome === 'empty') return []
          if (outcome === 'skipped')
            return [{ status: 'skipped', reason: 'no-refresh-token' }]
          if (outcome === 'refused')
            return [
              {
                status: 'refused',
                kind: 'duplicate-identity',
                message: 'credential-safe detail',
              },
            ]
          const result = await commit(...args)
          return [...result, ...result]
        },
      )
      try {
        await expect(f.login()).rejects.toThrow(FAILED)
        expect(await rows(f)).toHaveLength(outcome === 'multiple' ? 1 : 0)
      } finally {
        writer.mockRestore()
        await f.cleanup()
      }
    })
  }
})
