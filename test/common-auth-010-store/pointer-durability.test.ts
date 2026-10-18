import { describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AccountMigrationModules,
  accountStorePointerPath,
  createAccountMigrationFactory,
  createAccountRollbackFactory,
  initializeFreshAccountStore,
  resolvePublishedAccountStorePaths,
} from '../../packages/core/src/account-migration.ts'
import { loadCommonAuthStoreModules } from '../../packages/core/src/common-auth-runtime.ts'
import { MIGRATION_SOURCE, withMigrationFixtures } from './migration-child.ts'

interface Event {
  kind:
    | 'file-sync'
    | 'directory-sync'
    | 'lock'
    | 'rename'
    | 'pointer-create'
    | 'link'
  path: string
}

// Every observation delegates to the real filesystem and the real embedded store.
async function observe(body: (events: Event[]) => Promise<void>) {
  const events: Event[] = []
  const actualOpen = fs.open
  const actualRename = fs.rename
  const actualLink = fs.link
  const opened = spyOn(fs, 'open').mockImplementation(async (...args) => {
    const path = String(args[0])
    if (path.includes('.store.pointer.json.') && args[1] === 'wx')
      events.push({ kind: 'pointer-create', path })
    const handle = await actualOpen(...args)
    if (path.endsWith('.lock') && args[1] === 'wx')
      events.push({ kind: 'lock', path })
    const directory = (await handle.stat()).isDirectory()
    const actualSync = handle.sync.bind(handle)
    handle.sync = async () => {
      await actualSync()
      events.push({ kind: directory ? 'directory-sync' : 'file-sync', path })
    }
    return handle
  })
  const renamed = spyOn(fs, 'rename').mockImplementation(async (...args) => {
    await actualRename(...args)
    events.push({ kind: 'rename', path: String(args[1]) })
  })
  const linked = spyOn(fs, 'link').mockImplementation(async (...args) => {
    await actualLink(...args)
    events.push({ kind: 'link', path: String(args[1]) })
  })
  try {
    await body(events)
  } finally {
    opened.mockRestore()
    renamed.mockRestore()
    linked.mockRestore()
  }
}

async function stagePaths(legacyPath: string) {
  const root = join(legacyPath, '..')
  const generation = (await fs.readdir(root)).find((name) =>
    name.endsWith('.generation'),
  )
  if (!generation) throw new Error('missing freshly saved generation')
  const journalPath = join(root, generation, 'migration.json')
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
  const pointer = {
    schemaVersion: 1,
    id: journal.id,
    directoryBasename: generation,
  }
  return {
    journalPath,
    journal,
    stage: `${accountStorePointerPath(legacyPath)}.${journal.id}.tmp`,
    bytes: Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`),
  }
}

describe.skipIf(process.platform === 'win32')(
  'pointer publication durability',
  () => {
    it('measures clean empty initialization with the embedded store', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        await observe(async (events) => {
          expect(
            (
              await initializeFreshAccountStore(modules, {
                legacyPath: fixture.legacyPath,
                now: () => 100,
              })
            ).status,
          ).toBe('completed')
          const counts = (kind: Event['kind']) =>
            events.filter((e) => e.kind === kind).length
          const measured = {
            file: counts('file-sync'),
            directory: counts('directory-sync'),
            locks: counts('lock'),
            renames: counts('rename'),
          }
          console.info(
            'empty initialization delegated filesystem counts',
            measured,
          )
          expect(measured).toEqual({
            file: 24,
            directory: 17,
            locks: 18,
            renames: 13,
          })
          const start = events.findIndex(
            (event) => event.kind === 'pointer-create',
          )
          const stage = events[start]?.path
          if (stage === undefined)
            throw new Error('pointer creation was not observed')
          expect(events.slice(start, start + 5)).toEqual([
            { kind: 'pointer-create', path: stage },
            { kind: 'file-sync', path: stage },
            { kind: 'directory-sync', path: fixture.root },
            { kind: 'link', path: accountStorePointerPath(fixture.legacyPath) },
            { kind: 'directory-sync', path: fixture.root },
          ])
        })
      })
    })

    it('syncs a validated reused pointer stage before linking', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        let stage = ''
        await observe(async (events) => {
          expect(
            (
              await initializeFreshAccountStore(modules, {
                legacyPath: fixture.legacyPath,
                now: () => 100,
                async onBoundary(point) {
                  if (point === 'pointer:before-publication') {
                    const paths = await stagePaths(fixture.legacyPath)
                    stage = paths.stage
                    await fs.writeFile(stage, paths.bytes, {
                      mode: 0o600,
                      flag: 'wx',
                    })
                  }
                  if (point === 'pointer:before-link') {
                    expect(
                      events.filter(
                        (e) => e.kind === 'file-sync' && e.path === stage,
                      ),
                    ).toHaveLength(1)
                    expect(events.at(-1)).toEqual({
                      kind: 'directory-sync',
                      path: fixture.root,
                    })
                  }
                },
              })
            ).status,
          ).toBe('completed')
          expect(stage).not.toBe('')
        })
      })
    })

    it('keeps captured-journal barriers without an explicit same-owner save', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create(MIGRATION_SOURCE)
        const modules = await loadCommonAuthStoreModules()
        let checked = false
        await observe(async (events) => {
          expect(
            (
              await createAccountMigrationFactory(modules)({
                legacyPath: fixture.legacyPath,
                now: () => 100,
                offline: { processesStopped: true },
                async onBoundary(point) {
                  if (point !== 'pointer:before-link') return
                  const { journalPath } = await stagePaths(fixture.legacyPath)
                  expect(
                    events.filter(
                      (e) => e.kind === 'file-sync' && e.path === journalPath,
                    ),
                  ).toHaveLength(2)
                  expect(
                    events.filter(
                      (e) =>
                        e.kind === 'directory-sync' &&
                        e.path === join(journalPath, '..'),
                    ),
                  ).toHaveLength(2)
                  checked = true
                },
              })
            ).status,
          ).toBe('completed')
        })
        expect(checked).toBe(true)
      })
    })

    for (const damage of ['uuid', 'content'] as const)
      it(`rejects canonical journal ${damage} changes after the owned save`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          await observe(async (events) => {
            await expect(
              initializeFreshAccountStore(modules, {
                legacyPath: fixture.legacyPath,
                now: () => 100,
                async onBoundary(point) {
                  if (point !== 'pointer:before-publication') return
                  const { journalPath, journal } = await stagePaths(
                    fixture.legacyPath,
                  )
                  if (damage === 'uuid')
                    journal.id = '00000000-0000-4000-8000-000000000001'
                  else journal.phase = 'build'
                  await fs.writeFile(
                    journalPath,
                    `${JSON.stringify(journal)}\n`,
                  )
                },
              }),
            ).rejects.toThrow()
            expect(
              events.some(
                (e) => e.kind === 'pointer-create' || e.kind === 'link',
              ),
            ).toBe(false)
          })
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })

    for (const owner of ['management', 'topology'] as const)
      it(`asserts ${owner} ownership even after an owned save`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          let lose = false
          const guarded: AccountMigrationModules = {
            ...modules,
            fs: {
              ...modules.fs,
              withLock(path, options, body) {
                return modules.fs.withLock(path, options, (lease) =>
                  body({
                    async assertOwned() {
                      await lease.assertOwned()
                      const selected =
                        owner === 'topology'
                          ? path === fixture.legacyPath
                          : path.endsWith('/config.json')
                      if (
                        lose &&
                        selected &&
                        options.name === 'antigravity-management'
                      )
                        throw new Error('synthetic lost publication lease')
                    },
                  }),
                )
              },
            },
          }
          await expect(
            initializeFreshAccountStore(guarded, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
              onBoundary(point) {
                if (point === 'pointer:before-publication') lose = true
              },
            }),
          ).rejects.toThrow('synthetic lost publication lease')
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })

    for (const damage of ['bytes', 'mode'] as const)
      it(`rejects a reused pointer stage with wrong ${damage}`, async () => {
        await withMigrationFixtures(async (create) => {
          const fixture = await create()
          await fs.unlink(fixture.legacyPath)
          const modules = await loadCommonAuthStoreModules()
          await expect(
            initializeFreshAccountStore(modules, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
              async onBoundary(point) {
                if (point !== 'pointer:before-publication') return
                const { stage, bytes } = await stagePaths(fixture.legacyPath)
                await fs.writeFile(
                  stage,
                  damage === 'bytes' ? Buffer.from('{}\n') : bytes,
                  { mode: 0o600, flag: 'wx' },
                )
                if (damage === 'mode') await fs.chmod(stage, 0o644)
              },
            }),
          ).rejects.toThrow()
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        })
      })

    it('does not publish when the created pointer write-handle sync fails', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create()
        await fs.unlink(fixture.legacyPath)
        const modules = await loadCommonAuthStoreModules()
        const actualOpen = fs.open
        let reached = false
        const opened = spyOn(fs, 'open').mockImplementation(async (...args) => {
          const handle = await actualOpen(...args)
          if (
            String(args[0]).includes('.store.pointer.json.') &&
            args[1] === 'wx'
          ) {
            handle.sync = async () => {
              reached = true
              throw new Error('synthetic pointer sync failure')
            }
          }
          return handle
        })
        try {
          await expect(
            initializeFreshAccountStore(modules, {
              legacyPath: fixture.legacyPath,
              now: () => 100,
            }),
          ).rejects.toThrow('synthetic pointer sync failure')
          expect(reached).toBe(true)
          await expect(
            fs.lstat(accountStorePointerPath(fixture.legacyPath)),
          ).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
          opened.mockRestore()
        }
      })
    })

    it('keeps bootstrap backup retired and export double file syncs', async () => {
      await withMigrationFixtures(async (create) => {
        const fixture = await create({
          version: 4,
          accounts: [],
          activeIndex: 0,
        })
        const modules = await loadCommonAuthStoreModules()
        const hash = createHash('sha256')
          .update(await fs.readFile(fixture.legacyPath))
          .digest('hex')
        const request = {
          legacyPath: fixture.legacyPath,
          now: () => 100,
          offline: { processesStopped: true as const },
        }
        await observe(async (events) => {
          expect(
            (await createAccountMigrationFactory(modules)(request)).status,
          ).toBe('completed')
          const paths = await resolvePublishedAccountStorePaths(
            fixture.legacyPath,
          )
          if (!paths) throw new Error('migration did not publish')
          const syncs = (path: string) =>
            events.filter((e) => e.kind === 'file-sync' && e.path === path)
              .length
          expect(syncs(join(paths.backupsDir, `${hash}.json`))).toBe(2)
          const journal = JSON.parse(
            await fs.readFile(paths.migrationPath, 'utf8'),
          )
          expect(syncs(join(paths.retiredDir, `${journal.id}.json`))).toBe(2)
          // The bootstrap's two syncs precede the first native config replacement.
          const firstConfigRename = events.findIndex(
            (e) => e.kind === 'rename' && e.path === paths.configPath,
          )
          expect(
            events
              .slice(0, firstConfigRename)
              .filter(
                (e) => e.kind === 'file-sync' && e.path === paths.configPath,
              ),
          ).toHaveLength(2)
          events.length = 0
          expect(
            (await createAccountRollbackFactory(modules)(request)).status,
          ).toBe('completed')
          const rolledBack = JSON.parse(
            await fs.readFile(paths.migrationPath, 'utf8'),
          )
          expect(
            syncs(join(paths.transfersDir, `${rolledBack.rollback.id}.json`)),
          ).toBe(2)
          expect(syncs(fixture.legacyPath)).toBeGreaterThanOrEqual(2)
        })
      })
    })
  },
)
