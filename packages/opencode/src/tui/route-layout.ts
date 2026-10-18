/** Whether a labeled route row fits without wrapping at the measured width. */
export function routeLineFits(
  label: string,
  value: string,
  width: number,
): boolean {
  return label.length + 1 + value.length <= width
}

function fitPrimaryPart(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value
  if (maxWidth <= 0) return ''

  let fitted = ''
  for (const word of value.trim().split(/\s+/)) {
    const candidate = fitted ? `${fitted} ${word}` : word
    if (candidate.length > maxWidth) {
      const marked = fitted ? `${fitted}…` : '…'
      return marked.length <= maxWidth ? marked : fitted
    }
    fitted = candidate
  }
  return fitted
}

/**
 * Keeps route parts in priority order, dropping later parts before shortening
 * the first part at a word boundary.
 */
export function fitRouteParts(
  label: string,
  parts: readonly string[],
  width: number,
): string {
  const [primary = '', ...optional] = parts
  let value = fitPrimaryPart(primary, width - label.length - 1)
  for (const part of optional) {
    const candidate = `${value} · ${part}`
    if (!routeLineFits(label, candidate, width)) break
    value = candidate
  }
  return value
}
