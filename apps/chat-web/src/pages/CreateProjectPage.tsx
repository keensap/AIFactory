import { useState } from 'react'
import { errorMessage, type ChatApi } from '../api/client.ts'
import type { ProjectStatus } from '../api/types.ts'
import { AppHeader } from '../components/AppHeader.tsx'
import { DirectoryPicker } from '../components/DirectoryPicker.tsx'
import { ArrowLeftIcon, FolderIcon, InfoIcon } from '../components/Icons.tsx'
import type { ApiHealthState } from '../hooks/useApiHealth.ts'
import type { ProjectsMode } from '../hooks/useProjects.ts'
import type { Project, ProjectDraft } from '../data/projects.ts'
import { routeHref } from '../lib/router.ts'

export interface CreateProjectPageProps {
  api: ChatApi
  projectsMode: ProjectsMode
  health: ApiHealthState
  theme: 'light' | 'dark'
  onOpenSettings: () => void
  onToggleTheme: () => void
  onCreate: (draft: ProjectDraft) => Promise<Project>
  onCreated: (project: Project) => void
}

const STATUSES: { value: ProjectStatus; label: string; hint: string }[] = [
  { value: 'active', label: 'Active', hint: 'Shown as a card on the home page' },
  { value: 'inactive', label: 'Inactive', hint: 'Listed below the active projects' },
  { value: 'archived', label: 'Archived', hint: 'Read-only: no new chats' },
]

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function CreateProjectPage({
  api,
  projectsMode,
  health,
  theme,
  onOpenSettings,
  onToggleTheme,
  onCreate,
  onCreated,
}: CreateProjectPageProps) {
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [organization, setOrganization] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [status, setStatus] = useState<ProjectStatus>('active')
  const [description, setDescription] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | undefined>()

  const registry = projectsMode === 'api'
  const nameError = name.trim() === '' ? 'Give the project a name.' : undefined
  const pathError = rootPath.trim() === ''
    ? 'Choose the project directory.'
    : !rootPath.trim().startsWith('/')
      ? 'Use an absolute path, e.g. /srv/projects/my-app.'
      : undefined
  const emailError = ownerEmail.trim() !== '' && !EMAIL.test(ownerEmail.trim())
    ? 'Enter a valid email address.'
    : undefined

  const submit = async (): Promise<void> => {
    setTouched(true)
    if (nameError !== undefined || pathError !== undefined || emailError !== undefined) return
    if (projectsMode === 'loading') {
      setFormError('Still connecting to the project registry. Try again in a moment.')
      return
    }
    setBusy(true)
    setFormError(undefined)
    const draft: ProjectDraft = registry
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
          description: description.trim(),
          color: 'teal',
          workspace: rootPath.trim(),
          branch: '',
        }
    try {
      onCreated(await onCreate(draft))
    } catch (error) {
      setFormError(errorMessage(error))
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <AppHeader
        health={health}
        theme={theme}
        onOpenSettings={onOpenSettings}
        onToggleTheme={onToggleTheme}
      />

      <main className="page-main page-narrow">
        <a className="back-link" href={routeHref({ name: 'home' })}>
          <ArrowLeftIcon size={15} /> All projects
        </a>

        <div className="page-title">
          <h1>Create project</h1>
          <p>
            Point the project at a directory on the machine running the Chat API. Chats in this
            project run the harness inside that directory.
          </p>
        </div>

        {projectsMode === 'local' && (
          <p className="page-notice" role="status">
            <InfoIcon size={15} />
            <span>
              The project registry is unavailable, so this project will be saved in this browser only.
            </span>
          </p>
        )}

        <form
          className="form create-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <fieldset className="form-card">
            <legend>Required</legend>
            <label className="field">
              <span className="field-label">Project name</span>
              <input
                className="text-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Customer portal"
                maxLength={200}
                autoFocus
                aria-invalid={touched && nameError !== undefined}
              />
              {touched && nameError !== undefined && <span className="field-error">{nameError}</span>}
            </label>

            <div className="field">
              <label className="field-label" htmlFor="project-root">Project directory</label>
              <div className="path-field">
                <input
                  id="project-root"
                  className="text-input mono"
                  value={rootPath}
                  onChange={(event) => setRootPath(event.target.value)}
                  placeholder="/srv/projects/customer-portal"
                  spellCheck={false}
                  aria-invalid={touched && pathError !== undefined}
                  aria-describedby="project-root-hint"
                />
                <button type="button" className="button button-secondary" onClick={() => setPickerOpen(true)}>
                  <FolderIcon size={15} /> Browse…
                </button>
              </div>
              <span id="project-root-hint" className="field-hint">
                An existing absolute directory. Each directory can belong to only one project, and
                removing the project never deletes the directory.
              </span>
              {touched && pathError !== undefined && <span className="field-error">{pathError}</span>}
            </div>
          </fieldset>

          <fieldset className="form-card">
            <legend>Optional</legend>
            {registry ? (
              <>
                <div className="field-row">
                  <label className="field">
                    <span className="field-label">Organization</span>
                    <input
                      className="text-input"
                      value={organization}
                      onChange={(event) => setOrganization(event.target.value)}
                      placeholder="e.g. Acme"
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Owner email</span>
                    <input
                      className="text-input"
                      type="email"
                      value={ownerEmail}
                      onChange={(event) => setOwnerEmail(event.target.value)}
                      placeholder="owner@example.com"
                      aria-invalid={touched && emailError !== undefined}
                    />
                    {touched && emailError !== undefined && <span className="field-error">{emailError}</span>}
                  </label>
                </div>
                <div className="field">
                  <span className="field-label">Status</span>
                  <div className="choice-row" role="radiogroup" aria-label="Status">
                    {STATUSES.map((option) => (
                      <label key={option.value} className="choice" data-selected={status === option.value || undefined}>
                        <input
                          type="radio"
                          name="status"
                          value={option.value}
                          checked={status === option.value}
                          onChange={() => setStatus(option.value)}
                        />
                        <span className="choice-label">{option.label}</span>
                        <span className="choice-hint">{option.hint}</span>
                      </label>
                    ))}
                  </div>
                  <span className="field-hint">The API may limit how many projects can be active at once.</span>
                </div>
              </>
            ) : (
              <label className="field">
                <span className="field-label">Description</span>
                <textarea
                  className="text-input text-area"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            )}
          </fieldset>

          {formError !== undefined && <p className="form-error" role="alert">{formError}</p>}

          <div className="form-actions">
            <a className="button button-ghost" href={routeHref({ name: 'home' })}>Cancel</a>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </main>

      <DirectoryPicker
        open={pickerOpen}
        api={api}
        {...(rootPath.trim().startsWith('/') ? { initialPath: rootPath.trim() } : {})}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => {
          setRootPath(path)
          setPickerOpen(false)
          if (name.trim() === '') setName(path.split('/').filter(Boolean).pop() ?? '')
        }}
      />
    </div>
  )
}
