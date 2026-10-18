# Configuration

This guide covers setup, manual registration, and plugin settings. V1 means OpenCode 1; GA means OpenCode 2 general availability. For native GA login and request ownership, see [OpenCode 2](OPENCODE-2.md). Before a major upgrade, follow the [auto-update hold and offline migration](MIGRATION.md).

## Guided setup

Quit all OpenCode and Pi processes, then run:

```bash
npx @cortexkit/opencode-antigravity-auth setup
```

Setup detects installed hosts, uses local Google sign-in or optional approved Claustrum vault enrollment, writes versioned OpenCode registrations without replacing unrelated settings, or runs Pi's package installer. An existing legacy JSON account pool needs [offline migration](MIGRATION.md) into the shared store before use; Pi's native `auth.json` is not an OpenCode pool.

```bash
npx @cortexkit/opencode-antigravity-auth setup --dry-run --opencode=1 --no-claustrum
npx @cortexkit/opencode-antigravity-auth setup --yes --opencode=2 --no-claustrum
```

- `--opencode=1|2|both` resolves ambiguous host detection.
- `--no-claustrum` skips vault enrollment; `--claustrum` requires the running vault and operator approval using the printed request ID and `ck auth enroll approve` command.
- `--login` requests a new local OAuth login for OpenCode 1 or Pi instead of reuse. OpenCode 2 defers local OAuth to `opencode auth login`: select Google, then **Google (antigravity-auth pool, browser)** as the login method, and finally select the saved **Antigravity** connection. Setup does not complete that connection; stop if the method is absent. Do not substitute a real API key or the vault method for pool login.
- For approved OpenCode 2 vault mode, choose **Use approved Antigravity vault** through the same native login route. With `--opencode=both`, OpenCode 1's `auth.json` slot does not complete the separate OpenCode 2 step.
- `--yes` accepts host selection, not unsafe concurrent use or OAuth/vault approval. Start the configured host afterward and open `/antigravity`.

Pi's native login follows `PI_CODING_AGENT_DIR` (including `~` expansion), or `~/.pi/agent` by default. `PI_AGENT_DIR` and `PI_ANTIGRAVITY_AUTH_FILE` retain their plugin account/vault-state roles; they do not redirect native login. A different extension-state folder must not be mistaken for the native `auth.json` folder. Vault activation saves the native Google login in owner-only `antigravity-auth-vault/google-login-stash.json`, beside the extension's configured account file, before replacing the native login with a non-secret marker.

Real-run preflight runs **only after the stopped-host process fence**. The unchanged public credential and enrollment-state readers may create missing auth/state parent directories owned by the current user, acquire/release Pi native-slot and saved-login-stash locks, and tighten Windows auth, stash, and enrollment-authority-file DACLs (access permissions) to owner-only. `PrivateFileMigration` warnings stay visible. These metadata effects never change contents, ownership, permissions on existing ancestors, account authority, or configuration. Preflight is advisory: `enterVault` (vault activation) and each operation's fresh authority/slot checks remain authoritative, so revoked approval, changed native credentials, or inconsistent backups still refuse.

**Dry-run invokes none of those credential readers, locks, or repairs and writes nothing.** On macOS/Linux the stopped-host detector cannot reliably recognize an unquoted Node/Bun script path containing spaces in `ps` (for example `node /tmp/owned host/opencode`). Absence of a refusal is not proof the host exited; close and confirm all such instances manually. `--yes` does not override this requirement.

## OpenCode 1 manual registration

For V1 hosts exposing `opencode plugin`, check the matching host's help before using:

```bash
opencode plugin @cortexkit/opencode-antigravity-auth@latest
```

Inspect the resulting registrations. V1 has independent server and TUI files; merge these examples into existing configuration:

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth@latest"]
}
```

```jsonc
// ~/.config/opencode/tui.json
{
  "plugin": ["@cortexkit/opencode-antigravity-auth"]
}
```

Initialize a fresh local store or complete [offline migration](MIGRATION.md) before starting V1. Choose **Antigravity (Google OAuth)** in the Google provider login, or Sign in from `/antigravity`, then verify with `antigravity-auth quota`. The callback is `http://localhost:51121/oauth-callback`. See [commands](COMMANDS.md) for project selection and remote/headless login.

Do not reuse this singular `plugin`/`tui.json` recipe for GA; [OpenCode 2](OPENCODE-2.md#install-and-register) uses a different host surface. Pi installs with `pi install npm:@cortexkit/pi-antigravity-auth`, discovers the extension via `pi.extensions`, and logs in through `/login google`.

## Plugin configuration

Create `~/.config/opencode/antigravity.json` (or `.opencode/antigravity.json` in project root):

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json"
}
```

Most settings have sensible defaults — only configure what you need.

Project settings override user settings. `OPENCODE_CONFIG_DIR` overrides the user configuration directory; otherwise it follows `XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`). The [Zod schema](../src/plugin/config/schema.ts) is authoritative; the [generated JSON Schema](../assets/antigravity.schema.json) supplies editor validation.

---

## Quick Start

**Minimal config (recommended for most users):**

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json"
}
```

**With web search enabled:**

The plugin provides a `google_search` tool that the model can call to search the web. No configuration is needed - the tool is always available.

---

## Model Behavior

Settings that affect how the model thinks and responds.

| Option | Default | Description |
|--------|---------|-------------|
| `keep_thinking` | `false` | Preserve Claude's thinking blocks across turns. **Warning:** enabling may degrade model stability. |
| `session_recovery` | `true` | Auto-recover from tool_result_missing errors |
| `auto_resume` | `true` | Auto-send resume prompt after recovery |
| `resume_text` | `"continue"` | Text to send when auto-resuming |

> **Note:** The `web_search` config options are deprecated. Google Search is now implemented as a dedicated `google_search` tool that the model can call explicitly.

### About `keep_thinking`

When `true`, Claude's thinking blocks are preserved in conversation history:
- **Pros:** Model remembers its reasoning, more coherent across turns
- **Cons:** May degrade model stability, slightly larger context

When `false` (default), thinking is stripped:
- **Pros:** More stable model behavior, smaller context
- **Cons:** Model may be less coherent, forgets previous reasoning

---

## Account Rotation

Settings for managing multiple Google accounts.

Google retired Gemini CLI for consumer accounts on June 18, 2026. All requests now use Antigravity; old routing settings (`cli_first`, `quota_fallback`, `quota_style_fallback`, and `operator.routing`) in config are ignored.

| Option | Default | Description |
|--------|---------|-------------|
| `account_selection_strategy` | `"hybrid"` | How to select accounts |
| `switch_on_first_rate_limit` | `true` | Switch account immediately on first 429 |
| `pid_offset_enabled` | `false` | Distribute sessions across accounts (for parallel agents) |

### Strategy Guide

| Your Setup | Recommended Strategy | Why |
|------------|---------------------|-----|
| **1 account** | `"sticky"` | No rotation needed, preserve prompt cache |
| **2-3 accounts** | `"hybrid"` (default) | Smart rotation with health scoring |
| **4+ accounts** | `"round-robin"` | Maximum throughput |
| **Parallel agents** | `"round-robin"` + `pid_offset_enabled: true` | Distribute across accounts |

### Available Strategies

| Strategy | Behavior | Best For |
|----------|----------|----------|
| `sticky` | Same account until rate-limited | Single account, prompt cache |
| `round-robin` | Rotate on every request | Maximum throughput |
| `hybrid` | Health score + token bucket + LRU | Smart distribution (default) |

---

## App Behavior

Settings that control plugin behavior.

| Option | Default | Description |
|--------|---------|-------------|
| `quiet_mode` | `false` | Hide toast notifications (except recovery) |
| `debug` | `false` | Enable debug logging |
| `log_dir` | OS default | Custom directory for debug logs |
| `auto_update` | `true` | Enable automatic plugin updates |

### Debug Logging

```json
{
  "debug": true,
  "debug_tui": true
}
```

Logs are written to `~/.config/opencode/antigravity-logs/` (or `log_dir` if set).

---

## Recommended Configs

Copy-paste ready configs with recommended settings pre-applied.

### 1 Account

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json",
  "account_selection_strategy": "sticky"
}
```

**Why these settings:**
- `sticky` — No rotation needed, preserves Anthropic prompt cache

### 2-3 Accounts

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json",
  "account_selection_strategy": "hybrid"
}
```

**Why these settings:**
- `hybrid` — Smart rotation using health scores, avoids bad accounts

### 3+ Accounts (Power Users / Parallel Agents)

```json
{
  "$schema": "https://raw.githubusercontent.com/cortexkit/antigravity-auth/main/packages/opencode/assets/antigravity.schema.json",
  "account_selection_strategy": "round-robin",
  "switch_on_first_rate_limit": true,
  "pid_offset_enabled": true
}
```

**Why these settings:**
- `round-robin` — Maximum throughput, rotates every request
- `switch_on_first_rate_limit` — Immediately switch on 429 (default: true)
- `pid_offset_enabled` — Different sessions use different starting accounts

---

## What's Enabled by Default

These settings are already `true` by default — you don't need to set them:

| Setting | Default | What it does |
|---------|---------|--------------|
| `session_recovery` | `true` | Auto-recover from errors |
| `auto_update` | `true` | Keep plugin updated |
| `switch_on_first_rate_limit` | `true` | Fast account switching |

These settings are `false` by default:

| Setting | Default | What it does |
|---------|---------|--------------|
| `keep_thinking` | `false` | Preserve Claude thinking (may degrade stability) |

---

## Advanced error recovery

> These settings are for edge cases. Most users don't need to change them.

<details>
<summary><b>Error Recovery (internal)</b></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `empty_response_max_attempts` | `2` | Retries for empty API responses |
| `empty_response_retry_delay_ms` | `2000` | Delay between retries |
| `tool_id_recovery` | `true` | Fix mismatched tool IDs from context compaction |
| `claude_tool_hardening` | `true` | Prevent tool parameter hallucination |
| `max_rate_limit_wait_seconds` | `300` | Cumulative wait budget while no account is eligible, shared by rate limits and soft quota; resets on eligible selection (0=unlimited) |

</details>

## Additional settings and environment overrides

The [schema](../src/plugin/config/schema.ts) is the source of truth for complete bounds and defaults. The notification, warmup, retry, quota, account-floor, and logging settings formerly listed in the [root README](../../../README.md) are collected below:

| Setting | Default | Effect / environment override |
| --- | --- | --- |
| `toast_scope` | `root_only` | `all` includes subagent toasts; `OPENCODE_ANTIGRAVITY_TOAST_SCOPE` |
| `debug_tui` | `false` | TUI verbosity independent of file logging; `OPENCODE_ANTIGRAVITY_DEBUG_TUI=1` |
| `thinking_warmup` | `false` | Optional Claude probe for a missing thinking signature before tool-enabled requests |
| `cache_warmup_on_switch` | `true` | After switching accounts, send an extra copy of the prepared request, read one response chunk, then cancel that response before the normal send; `OPENCODE_ANTIGRAVITY_CACHE_WARMUP_ON_SWITCH=1` |
| `claude_prompt_auto_caching` | `false` | Add top-level `cache_control` when absent |
| `max_account_switches` | `10` | Per-request account budget; `OPENCODE_ANTIGRAVITY_MAX_ACCOUNT_SWITCHES` |
| `scheduling_mode` | `cache_first` | Also `balance` / `performance_first`; `OPENCODE_ANTIGRAVITY_SCHEDULING_MODE` |
| `max_cache_first_wait_seconds` | `60` | Wait cap for cache-first scheduling |
| `failure_ttl_seconds` | `3600` | Failure-count reset window |
| `default_retry_after_seconds` | `60` | Retry delay fallback |
| `max_backoff_seconds` | `60` | Exponential backoff cap |
| `request_jitter_max_ms` | `0` | Spread concurrent requests |
| `switch_account_delay_ms` | `500` | Delay before switching accounts |
| `soft_quota_threshold_percent` | `80` | Exclude accounts at this usage threshold; `100` disables |
| `quota_refresh_interval_minutes` | `30` | Opportunistic quota refresh cadence; `0` disables |
| `soft_quota_cache_ttl_minutes` | `auto` | `max(2 × refresh, 10)` minutes or an explicit TTL |
| `proactive_rotation_threshold_percent` | `20` | Remaining quota trigger; `OPENCODE_ANTIGRAVITY_PROACTIVE_ROTATION_THRESHOLD` |
| `operator.killswitch.enabled` | `false` | Hard exclusion switch |
| `operator.killswitch.minimum_remaining_percent` | `5` | Global remaining-quota floor |
| `operator.killswitch.accounts` | unset | Per-account floors, keyed by a short token hash, never a raw token |
| `operator.log_level` | `info` | `error`, `warn`, `info`, `debug`, `trace`; mutable via Diagnostics |

Use `OPENCODE_ANTIGRAVITY_QUIET=1`, `OPENCODE_ANTIGRAVITY_DEBUG=1`, and `OPENCODE_ANTIGRAVITY_LOG_DIR=/secure/path` for quiet mode, file logging, and log location respectively. Account strategy and PID offset also have `OPENCODE_ANTIGRAVITY_ACCOUNT_SELECTION_STRATEGY` and `OPENCODE_ANTIGRAVITY_PID_OFFSET_ENABLED` overrides. See [account and quota semantics](MULTI-ACCOUNT.md) rather than treating thresholds as live entitlement guarantees.

## State, cache, log, RPC, and dump files

| Purpose | Location | Notes |
| --- | --- | --- |
| Local account store | In the directory containing `antigravity-accounts.json` (default `~/.config/opencode`, or `OPENCODE_CONFIG_DIR`); `antigravity-accounts.json.store.pointer.json` selects the sibling `antigravity-accounts.json.store.<id>.generation/` directory | Owner-only `config.json` / `state.json`, journals, protected backups/transfers |
| Legacy pool | `$OPENCODE_CONFIG_DIR/antigravity-accounts.json` (default `~/.config/opencode/…`) | Migration input / successful V4 rollback output, not the active writer |
| Plugin config | Project `.opencode/antigravity.json`, then user config | Zod-validated settings |
| Debug logs / wire dumps | `antigravity-logs/` and `antigravity-logs/dumps/`, or `log_dir` | Sensitive request/response data; owner-only |
| OpenCode 1 sidebar | `$XDG_STATE_HOME/cortexkit/antigravity-auth/sidebar-state.json` | Override `ANTIGRAVITY_AUTH_SIDEBAR_STATE_FILE`; `0600` |
| OpenCode 1 RPC | `$XDG_STATE_HOME/cortexkit/antigravity-auth/rpc/<project-hash>/port-<pid>.json` | Override `ANTIGRAVITY_AUTH_RPC_DIR`; loopback bearer, `0600` files / `0700` directory |
| Signature cache | `signature-cache-disk-<hash>.json` under the `keep_thinking` path | `0600`; two-day default disk TTL |

OpenCode 1's sidebar polls every two seconds. Writers emit contract version `2` and skip newer-major files; readers accept `1` and `2` but refuse unknown majors. Missing, unreadable, malformed, or unsupported files produce an empty default state. Legacy reads never invent email, quota fractions, or observation timestamps. Top-level `checkedAt` is publication time, not a quota reading's observation time; undated quota is never current. The owner-only machine snapshot may include genuinely known email; renderer-safe projections exclude it from the UI, logs, and toasts, keeping ordinal labels. Session routing entries older than 24 hours are removed, and only the 100 newest entries are kept. Writes serialize, lock, re-read/merge, and atomically replace. Lock contention is reported to the caller; successful writes do not prove that the terminal rendered the snapshot. See the [sidebar contract](sidebar-contract.md) for detailed fields and version policy.

OpenCode 2 uses location-scoped snapshots and native host RPC, not OpenCode 1 port files. If OpenCode 1's sidebar stays on old readings or "Awaiting Antigravity state", stop the host, check the state path and its `0600` file permissions (owner read/write only), then restart. For missing RPC, verify the server loaded and the project-specific directory is writable; different projects have different hashed RPC directories.

Raw generative Antigravity sends use [agy-transport.ts](../../core/src/agy-transport.ts): separate default `180_000` ms response-header and no-body-data idle timeouts, **not** a total streaming deadline. Standard-fetch callers use [fetchWithActiveTimeout](../../core/src/fetch-timeout.ts), default `15_000` ms until headers; cancellation stays connected through body completion/error/cancel. That helper's 15s budget is not the raw Antigravity limit.

Each logical generation request also has a **fixed, provisional 10-minute pre-response limit**, pending real latency measurements. This is not a setting. It covers preparation, account selection and quota waits, warmups, endpoint/account retries, and failed-response classification until the accepted main response's headers arrive. An empty-response resend retains the original deadline. It does **not** promise a first visible token within ten minutes or limit the total duration of an accepted response body. The per-attempt 180-second header allowance is unchanged; body-idle limits remain 180 seconds in OpenCode 1/Pi and 300 seconds in GA.

The pre-response limit is independent of `max_rate_limit_wait_seconds`: the earlier active limit wins, with the existing quota refusal winning a tie. Setting the quota-wait option to `0` removes only that quota-wait cap, not the fixed pre-response limit. Expiry returns a native, nonretryable HTTP 412 (`FAILED_PRECONDITION`); Pi emits its native terminal error instead of assistant text. If the caller cancels a request, its cancellation outcome is preserved instead of being converted to a timeout refusal.

## Security and redaction

Keep local store generations, pointers, backups, transfer files, native Google auth slots, and vault custody files private. Filesystem permissions are not encryption. None belong in Git or support reports.

Renderer projections exclude refresh/access tokens, project IDs, and fingerprints; account labels and quota state are not credential backups. Killswitch account keys are short deterministic hashes, not raw tokens. Do not log them as a substitute for redaction.

File `debug` logs and raw wire dumps may include headers and request/response bodies. Avoid debug capture for sessions handling personal data, use a private/encrypted `log_dir` when appropriate, and share only redacted errors. `debug_tui` and the runtime log-level filter are independent knobs. See [the logging boundary](COMMON_AUTH_LOGGING.md).

Public Antigravity OAuth client identifiers and shipped headers are inspectable protocol constants, not account credentials. Refresh/access tokens, browser cookies, bearer tokens, and request/response dumps remain excluded from this repository, issues, and chat.

## Advanced token, cache, and selection settings

<details>
<summary><b>Token Management (internal)</b></summary>

| Option | Default | Description |
|--------|---------|-------------|
| `proactive_token_refresh` | `true` | Refresh tokens before expiry |
| `proactive_refresh_buffer_seconds` | `1800` | Refresh 30 min before expiry |
| `proactive_refresh_check_interval_seconds` | `300` | Check interval |

</details>

<details>
<summary><b>Signature Cache (internal)</b></summary>

Used when `keep_thinking: true`. Most users don't need to configure this.

| Option | Default | Description |
|--------|---------|-------------|
| `signature_cache.enabled` | `true` | Enable disk caching |
| `signature_cache.memory_ttl_seconds` | `3600` | In-memory cache TTL (1 hour) |
| `signature_cache.disk_ttl_seconds` | `172800` | Disk cache TTL (48 hours) |
| `signature_cache.write_interval_seconds` | `60` | Background write interval |

</details>

<details>
<summary><b>Health Score Tuning (internal)</b></summary>

Used by `hybrid` strategy. Most users don't need to configure this.

| Option | Default | Description |
|--------|---------|-------------|
| `health_score.initial` | `70` | Starting health score |
| `health_score.success_reward` | `1` | Points added on success |
| `health_score.rate_limit_penalty` | `-10` | Points removed on rate limit |
| `health_score.failure_penalty` | `-20` | Points removed on failure |
| `health_score.recovery_rate_per_hour` | `2` | Points recovered per hour |
| `health_score.min_usable` | `50` | Minimum score to use account |
| `health_score.max_score` | `100` | Maximum health score |

</details>

<details>
<summary><b>Token Bucket Tuning (internal)</b></summary>

Used by `hybrid` strategy. Most users don't need to configure this.

| Option | Default | Description |
|--------|---------|-------------|
| `token_bucket.max_tokens` | `50` | Maximum tokens in bucket |
| `token_bucket.regeneration_rate_per_minute` | `6` | Tokens regenerated per minute |
| `token_bucket.initial_tokens` | `50` | Starting tokens |

</details>
