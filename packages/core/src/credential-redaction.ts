const MARKER = '[credential]'
type Credentials = string | readonly string[] | undefined
type ProjectIds = readonly string[] | undefined

/** Use the same visible identifier shape as debug logs and request dumps. */
export function maskSensitiveIdentifier(
  value: string | undefined | null,
): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

export function redactProjectIdText(
  text: string,
  projectIds?: ProjectIds,
): string {
  const identifiers = [...new Set(projectIds ?? [])]
    .filter((projectId) => projectId.length > 0)
    .sort((left, right) => right.length - left.length)
  if (identifiers.length > 0) {
    const expression = new RegExp(
      identifiers
        .map((projectId) => projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|'),
      'g',
    )
    text = text.replace(expression, (projectId) =>
      maskSensitiveIdentifier(projectId),
    )
  }
  return text.replace(
    /(\bproject(?:[\s_-]*id)?\s*[:=]\s*)([a-z0-9_*][a-z0-9_*-]*)/gi,
    (match, label: string, value: string) =>
      /^(?:unknown|n\/?a)$/i.test(value) || value.includes('****')
        ? match
        : `${label}${maskSensitiveIdentifier(value)}`,
  )
}

/** Selected bearers can be opaque; scrub their exact values as well as recognizable token shapes. */
export function redactCredentialText(
  text: string,
  credentials?: Credentials,
  projectIds?: ProjectIds,
): string {
  text = redactProjectIdText(text, projectIds)
  for (const credential of typeof credentials === 'string'
    ? [credentials]
    : (credentials ?? [])) {
    if (credential) text = text.split(credential).join(MARKER)
  }
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, MARKER)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, MARKER)
}

function scrub(
  value: unknown,
  credentials: Credentials,
  projectIds: ProjectIds,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string')
    return redactCredentialText(value, credentials, projectIds)
  if (!value || typeof value !== 'object') return value
  if (!containsCredential(value, credentials, projectIds)) return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  const safe = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value))
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (
      key === 'cause' &&
      (!('value' in descriptor) ||
        containsCredential(descriptor.value, credentials, projectIds))
    )
      continue
    Object.defineProperty(
      safe,
      key,
      'value' in descriptor
        ? {
            ...descriptor,
            value: scrub(descriptor.value, credentials, projectIds, seen),
          }
        : descriptor,
    )
  }
  return safe
}

function containsCredential(
  value: unknown,
  credentials: Credentials,
  projectIds: ProjectIds,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === 'string')
    return redactCredentialText(value, credentials, projectIds) !== value
  if (!value || typeof value !== 'object' || seen.has(value)) return false
  seen.add(value)
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    return (
      'value' in descriptor &&
      containsCredential(descriptor.value, credentials, projectIds, seen)
    )
  })
}

/** Keep writable transport errors and routing metadata; immutable errors need a safe replacement. */
export function redactCredentialError(
  error: unknown,
  credentials?: Credentials,
  projectIds?: ProjectIds,
): Error {
  const source =
    error instanceof Error || error instanceof DOMException ? error : undefined
  const message = redactCredentialText(
    source?.message ?? String(error),
    credentials,
    projectIds,
  )
  const fields = source
    ? Reflect.ownKeys(source).map((key) => ({
        key,
        descriptor: Object.getOwnPropertyDescriptor(source, key)!,
      }))
    : []
  const cause = fields.find(({ key }) => key === 'cause')?.descriptor
  const secretCause =
    cause &&
    (!('value' in cause) ||
      containsCredential(cause.value, credentials, projectIds))
  try {
    if (source) {
      if (message !== source.message)
        Object.defineProperty(source, 'message', {
          value: message,
          configurable: true,
          writable: true,
        })
      for (const { key, descriptor } of fields) {
        if (key === 'message' || key === 'cause' || !('value' in descriptor))
          continue
        const value = scrub(descriptor.value, credentials, projectIds)
        if (value !== descriptor.value)
          Object.defineProperty(source, key, { ...descriptor, value })
      }
      if (secretCause) delete (source as Error).cause
      return source
    }
  } catch {
    // Frozen diagnostics cannot keep unsafe text, but their classification still matters.
  }
  const safe = new Error(message)
  safe.name = redactCredentialText(
    source?.name ?? 'Error',
    credentials,
    projectIds,
  )
  for (const { key, descriptor } of fields) {
    if (key === 'message' || key === 'cause' || !('value' in descriptor))
      continue
    Object.defineProperty(safe, key, {
      ...descriptor,
      configurable: true,
      writable: true,
      value: scrub(descriptor.value, credentials, projectIds),
    })
  }
  if (cause && !secretCause && 'value' in cause) safe.cause = cause.value
  return safe
}

function redactDiagnosticText(
  text: string,
  credentials?: Credentials,
  projectIds?: ProjectIds,
  parsed?: unknown,
): string {
  const direct = redactCredentialText(text, credentials, projectIds)
  if (direct !== text || !text.includes('\\u')) return direct
  try {
    // JSON escapes can hide a credential even after the diagnostic is recognized.
    const canonical = JSON.stringify(parsed ?? JSON.parse(text))
    const safe = redactCredentialText(canonical, credentials, projectIds)
    return safe === canonical ? text : safe
  } catch {
    return text
  }
}

/** Ordinary model text, including text that mentions errors or tokens, is not a diagnostic. */
export function redactCredentialFrame(
  frame: string,
  credentials?: Credentials,
  projectIds?: ProjectIds,
): string {
  if (!frame.includes('"error"') && !frame.includes('\\u')) return frame
  try {
    const value = JSON.parse(frame)
    if (value?.type === 'error' || value?.error || value?.response?.error) {
      return redactDiagnosticText(frame, credentials, projectIds, value)
    }
  } catch {
    // Non-JSON data is not an error envelope.
  }
  return frame
}

/** Body wrappers must retain fetch metadata in addition to status and headers. */
export function preserveResponseMetadata(
  response: Response,
  original: Response,
): Response {
  for (const key of ['url', 'type', 'redirected'] as const) {
    Object.defineProperty(response, key, {
      value: original[key],
      configurable: true,
    })
  }
  return response
}

/** Scrub failed HTTP diagnostics and SSE error frames, never successful content. */
export async function redactCredentialResponse(
  response: Response,
  credentials?: Credentials,
  bufferedBody?: string,
  projectIds?: ProjectIds,
): Promise<Response> {
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  }
  if (!response.ok) {
    init.statusText = redactCredentialText(
      init.statusText,
      credentials,
      projectIds,
    )
    let metadataChanged = init.statusText !== response.statusText
    for (const [key, value] of init.headers) {
      const safe = redactCredentialText(value, credentials, projectIds)
      if (safe !== value) {
        init.headers.set(key, safe)
        metadataChanged = true
      }
    }
    const text =
      bufferedBody ??
      (response.body
        ? await response.text().catch((error: unknown) => {
            throw redactCredentialError(error, credentials, projectIds)
          })
        : null)
    const redacted =
      text === null ? null : redactDiagnosticText(text, credentials, projectIds)
    if (
      (bufferedBody !== undefined || !response.body) &&
      redacted === text &&
      !metadataChanged
    )
      return response
    if (response.body) init.headers.delete('content-length')
    return preserveResponseMetadata(new Response(redacted, init), response)
  }
  if (
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  )
    return response
  init.headers.delete('content-length')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  const redact = (event: string) =>
    event.replace(
      /^data: ?([^\r\n]*)/gm,
      (line, data: string) =>
        line.slice(0, line.length - data.length) +
        redactCredentialFrame(data, credentials, projectIds),
    )
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const next = await reader.read()
          pending += decoder.decode(next.value, { stream: !next.done })
          let emitted = false
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(pending)
            if (!boundary) break
            const end = boundary.index + boundary[0].length
            controller.enqueue(encoder.encode(redact(pending.slice(0, end))))
            pending = pending.slice(end)
            emitted = true
          }
          if (next.done) {
            if (pending) controller.enqueue(encoder.encode(redact(pending)))
            controller.close()
            reader.releaseLock()
            return
          }
          if (emitted) return
        }
      } catch (error) {
        reader.releaseLock()
        controller.error(redactCredentialError(error, credentials, projectIds))
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } catch (error) {
        throw redactCredentialError(error, credentials, projectIds)
      } finally {
        reader.releaseLock()
      }
    },
  })
  return preserveResponseMetadata(new Response(body, init), response)
}
