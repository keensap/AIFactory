import type { PromptSection } from './sections.ts'

/** Render in stable order. Budgets count UTF-16 code units, excluding the cut marker. */
export function renderPrompt(sections: readonly PromptSection[]) {
  const ids = new Set<string>()
  const rendered = [...sections].sort((a, b) => a.order - b.order).map((section) => {
    const { id, body, maxChars } = section
    if (ids.has(id)) throw new Error(`Duplicate prompt section: ${id}`)
    ids.add(id)
    if (maxChars !== undefined && (!Number.isSafeInteger(maxChars) || maxChars < 0)) {
      throw new RangeError(`Invalid prompt budget for ${id}`)
    }
    const truncated = maxChars !== undefined && body.length > maxChars
    let retained = truncated ? body.slice(0, maxChars) : body
    if (truncated && /[\uD800-\uDBFF]$/.test(retained)) retained = retained.slice(0, -1)
    const text = truncated ? `${retained}\n[Truncated ${id}: original ${body.length} chars]` : retained
    return { text, meta: { id, originalChars: body.length, chars: text.length, truncated } }
  })
  return { text: rendered.map(({ text }) => text).join('\n\n'), sections: rendered.map(({ meta }) => meta) }
}
