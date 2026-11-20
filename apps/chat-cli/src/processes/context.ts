import { renderAttachmentPrompt } from '../attachments.ts'
import type { ContextAttachment, StageContextPacket } from '../stage-runtime.ts'

/**
 * The context with attachment text removed, for prompts that carry the documents
 * in a readable section instead. Avoids sending the same text twice.
 */
export function contextWithoutAttachmentText(context: StageContextPacket): Omit<StageContextPacket, 'attachments' | 'promptBundleVersion' | 'processParams'> & {
  attachments: Array<Omit<ContextAttachment, 'text'>>
} {
  const { promptBundleVersion: _version, processParams: _params, ...evidence } = context
  return {
    ...evidence,
    attachments: context.attachments.map(({ text: _text, ...meta }) => meta),
  }
}

/** The stage inputs, or an explicit note when there are none. */
export function attachmentSection(context: StageContextPacket): string {
  const rendered = renderAttachmentPrompt(context.attachments)
  return rendered === '' ? 'INPUT DOCUMENTS\nThe requester attached no documents for this stage.' : rendered
}
