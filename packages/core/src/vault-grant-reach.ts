import type { VaultGrantReach } from './vault-account-source.ts'

/**
 * Why an approved vault lists no accounts for this host, from the grants the
 * vault's latest listing named:
 *
 * - `no-grant`: the host holds no grant at all; the operator needs to grant
 *   read access.
 * - `grant-reaches-nothing`: the host holds a grant, but it matches no login
 *   in the vault, usually logins saved before they carried the category the
 *   grant selects.
 * - `unknown`: the vault, its client or this process has not reported the
 *   grants. An absent count is never read as zero grants.
 */
export type EmptyVaultRosterCause =
  | 'no-grant'
  | 'grant-reaches-nothing'
  | 'unknown'

export function emptyVaultRosterCause(
  reach: VaultGrantReach | undefined,
): EmptyVaultRosterCause {
  if (reach === undefined) return 'unknown'
  if (reach.grants === 0) return 'no-grant'
  return 'grant-reaches-nothing'
}

/**
 * The operator's commands when a grant matches no login: label the vault's
 * existing logins from the provider registry, then check what the vault now
 * holds.
 */
export const VAULT_RECLASSIFY_COMMAND = 'ck auth reclassify --from-registry'
export const VAULT_STATUS_COMMAND = 'ck auth status'
