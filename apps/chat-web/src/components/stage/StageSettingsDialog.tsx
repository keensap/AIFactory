import type { ChatApi } from '../../api/client.ts'
import type { StageKey } from '../../api/types.ts'
import { Modal } from '../Modal.tsx'
import { ReviewSettings } from './ReviewSettings.tsx'

/** Stage-specific project settings. */
export function StageSettingsDialog({ open, api, projectId, stageName, stage, onClose }: {
  open: boolean
  api: ChatApi
  projectId: string
  stageName: string
  stage: StageKey
  onClose: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${stageName} — stage settings`}
      description="How much the writer and reviewer do on their own before a person is asked."
      size="md"
    >
      {open && <ReviewSettings api={api} scope={{ kind: 'project', projectId, stage }} />}
    </Modal>
  )
}
