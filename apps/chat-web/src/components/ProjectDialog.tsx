import { useEffect, useState } from 'react'
import type { ProjectStatus } from '../api/types.ts'
import {
  PROJECT_COLORS,
  type Project,
  type ProjectColor,
  type ProjectDraft,
} from '../data/projects.ts'
import { errorMessage } from '../api/client.ts'
import { Modal } from './Modal.tsx'

export interface ProjectDialogProps {
  open: boolean
  mode: 'api' | 'local'
  project?: Project
  onClose: () => void
  onSave: (draft: ProjectDraft) => Promise<string | undefined>
}

const STATUSES: { value: ProjectStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'archived', label: 'Archived' },
]

export function ProjectDialog({ open, mode, project, onClose, onSave }: ProjectDialogProps) {
  const editing = project !== undefined
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState<ProjectColor>('teal')
  const [workspace, setWorkspace] = useState('')
  const [branch, setBranch] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [organization, setOrganization] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('inactive')
  const [touched, setTouched] = useState(false)
  const [formError, setFormError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(project?.name ?? '')
    setDescription(project?.description ?? '')
    setColor(project?.color ?? 'teal')
    setWorkspace(project?.workspace ?? '')
    setBranch(project?.branch ?? '')
    setRootPath(project?.workspace ?? '')
    setOrganization(project?.organization ?? '')
    setOwnerEmail(project?.ownerEmail ?? '')
    setStatus(project?.status ?? 'inactive')
    setTouched(false)
    setFormError(undefined)
    setBusy(false)
  }, [open, project])

  const nameError = name.trim() === '' ? 'Give the project a name.' : undefined
  const rootPathError = mode === 'api'
    ? rootPath.trim() === ''
      ? 'A root path is required.'
      : !rootPath.trim().startsWith('/')
        ? 'Use an absolute path.'
        : undefined
    : undefined

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (nameError !== undefined || rootPathError !== undefined) return
    setBusy(true)
    setFormError(undefined)

    const draft: ProjectDraft = mode === 'api'
      ? {
          kind: 'api',
          name: name.trim(),
          rootPath: rootPath.trim(),
          organization: organization.trim() === '' ? null : organization.trim(),
          ownerEmail: ownerEmail.trim() === '' ? null : ownerEmail.trim(),
          status,
        }
      : {
          kind: 'local',
          name: name.trim(),
          description,
          color,
          workspace,
          branch,
        }

    try {
      const failure = await onSave(draft)
      if (failure !== undefined) {
        setFormError(failure)
        return
      }
      onClose()
    } catch (error) {
      setFormError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit project' : 'New project'}
      description={mode === 'api'
        ? (editing
            ? 'Changes are saved in the PostgreSQL project registry.'
            : 'Register an existing root directory in the project database.')
        : (editing
            ? 'Changes are saved in this browser only.'
            : 'Create a local project to group chats while the registry is unavailable.')}
      footer={(
        <>
          <button type="button" className="button button-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="project-form"
            className="button button-primary"
            disabled={busy}
          >
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Create project'}
          </button>
        </>
      )}
    >
      <form
        id="project-form"
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="text-input"
            value={name}
            maxLength={mode === 'api' ? 200 : 60}
            autoFocus
            placeholder={mode === 'api' ? 'e.g. customer-portal' : 'e.g. Atlas Console'}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={touched && nameError !== undefined}
            aria-describedby={touched && nameError !== undefined ? 'project-name-error' : undefined}
          />
          {touched && nameError !== undefined && (
            <span className="field-error" id="project-name-error">{nameError}</span>
          )}
        </label>

        {mode === 'api' ? (
          <>
            <label className="field">
              <span className="field-label">Root path</span>
              <input
                className="text-input mono"
                value={rootPath}
                maxLength={1024}
                placeholder="/srv/projects/customer-portal"
                onChange={(event) => setRootPath(event.target.value)}
                    aria-invalid={touched && rootPathError !== undefined}
                aria-describedby={touched && rootPathError !== undefined ? 'project-root-error' : undefined}
              />
              {touched && rootPathError !== undefined && (
                <span className="field-error" id="project-root-error">{rootPathError}</span>
              )}
              <span className="field-hint">
                Must be an absolute path to an existing directory. The API canonicalises it
                and requires it to be unique across projects.
              </span>
            </label>
            <div className="field-row">
              <label className="field">
                <span className="field-label">Organization <span className="field-optional">optional</span></span>
                <input
                  className="text-input"
                  value={organization}
                  maxLength={200}
                  placeholder="Acme"
                  onChange={(event) => setOrganization(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Owner email <span className="field-optional">optional</span></span>
                <input
                  className="text-input"
                  value={ownerEmail}
                  maxLength={320}
                  type="email"
                  placeholder="owner@acme.example"
                  onChange={(event) => setOwnerEmail(event.target.value)}
                />
              </label>
            </div>
            <label className="field">
              <span className="field-label">Status</span>
              <select
                className="text-input"
                value={status}
                onChange={(event) => setStatus(event.target.value as ProjectStatus)}
              >
                {STATUSES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <span className="field-hint">
                The registry allows any number of active projects; removing a project
                never deletes its root directory.
              </span>
            </label>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Description</span>
              <textarea
                className="text-input text-area"
                value={description}
                rows={2}
                maxLength={240}
                placeholder="What is this project working on?"
                onChange={(event) => setDescription(event.target.value)}
              />
              <span className="field-hint">{description.length}/240</span>
            </label>

            <div className="field">
              <span className="field-label">Accent</span>
              <div className="color-row" role="group" aria-label="Project accent color">
                {PROJECT_COLORS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="color-swatch"
                    data-color={option.id}
                    aria-label={option.label}
                    aria-pressed={color === option.id}
                    title={option.label}
                    onClick={() => setColor(option.id)}
                  />
                ))}
              </div>
            </div>

            <div className="field-row">
              <label className="field">
                <span className="field-label">Workspace path</span>
                <input
                  className="text-input mono"
                  value={workspace}
                  maxLength={200}
                  placeholder="/workspace/atlas"
                  onChange={(event) => setWorkspace(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">Branch</span>
                <input
                  className="text-input mono"
                  value={branch}
                  maxLength={80}
                  placeholder="main"
                  onChange={(event) => setBranch(event.target.value)}
                />
              </label>
            </div>

            <p className="form-note">
              Workspace and branch are display-only placeholders. They are not sent to the
              harness.
            </p>
          </>
        )}

        {formError !== undefined && (
          <p className="form-error" role="alert">{formError}</p>
        )}
      </form>
    </Modal>
  )
}
