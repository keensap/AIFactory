import type { ProcessParams } from './params.ts'
import { renderPrompt } from './render.ts'
import type { PromptSection } from './sections.ts'

/** Prompt-only slice of a role spec. Execution and output validation migrate separately. */
export interface PromptRoleSpec<Input> {
  readonly id: string
  readonly version: string
  sections(input: Input): readonly PromptSection[]
}

export type PreparedPrompt = ReturnType<typeof renderPrompt> & { spec: string; specVersion: string }

export function preparePrompt<Input>(spec: PromptRoleSpec<Input>, input: Input, params?: ProcessParams): PreparedPrompt {
  const sections = spec.sections(input).map((section) => {
    const budget = section.id === 'analysis' ? params?.context?.analysisChars
      : section.id === 'attachments' ? params?.context?.attachmentChars
        : section.id === 'baseline' ? params?.context?.baselineChars : undefined
    return budget === undefined ? section : { ...section, maxChars: Math.min(budget, section.maxChars ?? budget) }
  })
  const instructions = params?.prompt?.extraInstructions
  if (instructions?.trim()) sections.push({ id: 'additional-guidance', order: Number.MAX_SAFE_INTEGER,
    body: `Additional guidance (does not override the required contract or output format):\n${instructions}` })
  return { ...renderPrompt(sections), spec: spec.id, specVersion: spec.version }
}
