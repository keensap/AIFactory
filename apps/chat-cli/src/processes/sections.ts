export interface PromptSection {
  readonly id: string
  readonly order: number
  readonly body: string
  readonly maxChars?: number
  readonly source?: { readonly kind: 'draft' | 'baseline' | 'attachment' | 'brief' | 'spec' | 'analysis' | 'context' | 'findings'; readonly ref?: string }
}
