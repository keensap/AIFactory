import { useEffect, useState } from 'react'
import { normalizeBaseUrl, type AppSettings, type ThemePreference } from '../data/settings.ts'
import type { ApiHealthState } from '../hooks/useApiHealth.ts'
import type { ProjectsMode } from '../hooks/useProjects.ts'
import { CheckIcon, MonitorIcon, MoonIcon, RefreshIcon, SunIcon } from './Icons.tsx'
import { Modal } from './Modal.tsx'

export interface TestResult {
  ok: boolean
  message: string
}

export interface SettingsDialogProps {
  open: boolean
  settings: AppSettings
  theme: ThemePreference
  health: ApiHealthState
  projectsMode: ProjectsMode
  projectsError?: string
  projectsLoading: boolean
  onClose: () => void
  onSave: (settings: AppSettings, theme: ThemePreference) => void
  onTest: (settings: AppSettings) => Promise<TestResult>
  onRefreshProjects: () => Promise<void>
}

const THEMES: { id: ThemePreference; label: string; icon: typeof SunIcon }[] = [
  { id: 'system', label: 'System', icon: MonitorIcon },
  { id: 'light', label: 'Light', icon: SunIcon },
  { id: 'dark', label: 'Dark', icon: MoonIcon },
]

export function SettingsDialog({
  open,
  settings,
  theme,
  health,
  projectsMode,
  projectsError,
  projectsLoading,
  onClose,
  onSave,
  onTest,
  onRefreshProjects,
}: SettingsDialogProps) {
  const [baseUrl, setBaseUrl] = useState(settings.apiBaseUrl)
  const [token, setToken] = useState(settings.apiToken)
  const [nextTheme, setNextTheme] = useState<ThemePreference>(theme)
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState('')

  useEffect(() => {
    if (!open) return
    setBaseUrl(settings.apiBaseUrl)
    setToken(settings.apiToken)
    setNextTheme(theme)
    setShowToken(false)
    setError(undefined)
    setTestState('idle')
    setTestMessage('')
  }, [open, settings, theme])

  const submit = (): void => {
    const normalized = normalizeBaseUrl(baseUrl)
    if (normalized === null) {
      setError('Enter a valid http:// or https:// URL.')
      return
    }
    setError(undefined)
    onSave({ apiBaseUrl: normalized, apiToken: token.trim() }, nextTheme)
  }

  const test = async (): Promise<void> => {
    const normalized = normalizeBaseUrl(baseUrl)
    if (normalized === null) {
      setError('Enter a valid http:// or https:// URL.')
      return
    }
    setError(undefined)
    setTestState('testing')
    setTestMessage('')
    const result = await onTest({ apiBaseUrl: normalized, apiToken: token.trim() })
    setTestState(result.ok ? 'ok' : 'error')
    setTestMessage(result.message)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      description="Connection and appearance. Settings are stored in this browser."
      footer={(
        <>
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button-primary" onClick={submit}>
            Save changes
          </button>
        </>
      )}
    >
      <div className="form">
        <section className="settings-section">
          <div className="settings-section-head">
            <h3>Chat API</h3>
            <span className="settings-status" data-status={health.status}>
              <span className="status-dot" />
              {health.status === 'online' ? 'Connected' : health.status === 'checking' ? 'Checking' : 'Not connected'}
            </span>
          </div>
          <label className="field">
            <span className="field-label">API base URL</span>
            <input
              className="text-input mono"
              value={baseUrl}
              placeholder="http://127.0.0.1:8787"
              onChange={(event) => {
                setBaseUrl(event.target.value)
                setTestState('idle')
              }}
              aria-invalid={error !== undefined}
            />
            {error !== undefined && <span className="field-error">{error}</span>}
            <span className="field-hint">
              Defaults to <code>http://127.0.0.1:8787</code>. The API must allow this
              origin via CORS; the default API config allows all origins.
            </span>
          </label>
          <label className="field">
            <span className="field-label">Bearer token <span className="field-optional">optional</span></span>
            <div className="input-with-action">
              <input
                className="text-input mono"
                type={showToken ? 'text' : 'password'}
                value={token}
                placeholder="Only needed when the API sets AIFACTORY_API_TOKEN"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setToken(event.target.value)
                  setTestState('idle')
                }}
              />
              <button
                type="button"
                className="input-action"
                onClick={() => setShowToken((shown) => !shown)}
              >
                {showToken ? 'Hide' : 'Show'}
              </button>
            </div>
            <span className="field-hint">
              Stored in localStorage. Use only on a trusted machine.
            </span>
          </label>
          <div className="settings-test-row">
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() => void test()}
              disabled={testState === 'testing'}
            >
              {testState === 'testing'
                ? <RefreshIcon size={14} className="spin" />
                : <RefreshIcon size={14} />}
              Test connection
            </button>
            {testState !== 'idle' && testState !== 'testing' && (
              <span className="test-result" data-ok={testState === 'ok' || undefined}>
                {testState === 'ok' && <CheckIcon size={14} />}
                {testMessage}
              </span>
            )}
            {testState === 'testing' && <span className="test-result">Contacting the API…</span>}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>Projects registry</h3>
            <span className="settings-status" data-status={projectsMode === 'api' ? 'online' : projectsMode === 'loading' ? 'checking' : 'offline'}>
              <span className="status-dot" />
              {projectsMode === 'api' ? 'PostgreSQL' : projectsMode === 'loading' ? 'Checking' : 'Local fallback'}
            </span>
          </div>
          <p className="settings-copy">
            {projectsMode === 'api'
              ? 'Project records are loaded from GET /api/projects. Chat-to-project grouping remains browser-local until the Chat API exposes project-scoped sessions.'
              : projectsMode === 'loading'
                ? 'Checking whether the API exposes a project registry…'
                : 'The project registry is unavailable, so projects are local placeholders. Chat still works; set DATABASE_URL before starting the API to enable PostgreSQL-backed projects.'}
          </p>
          {projectsMode === 'local' && projectsError !== undefined && (
            <p className="settings-error">{projectsError}</p>
          )}
          <div className="settings-test-row">
            <button
              type="button"
              className="button button-secondary button-sm"
              onClick={() => void onRefreshProjects()}
              disabled={projectsLoading}
            >
              <RefreshIcon size={14} className={projectsLoading ? 'spin' : undefined} />
              Reload projects
            </button>
          </div>
        </section>

        <section className="settings-section">
          <h3>Appearance</h3>
          <div className="theme-row" role="radiogroup" aria-label="Theme">
            {THEMES.map((option) => {
              const Icon = option.icon
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={nextTheme === option.id}
                  className="theme-card"
                  data-active={nextTheme === option.id || undefined}
                  onClick={() => setNextTheme(option.id)}
                >
                  <Icon size={17} />
                  <span>{option.label}</span>
                </button>
              )
            })}
          </div>
        </section>

        <div className="settings-note">
          <strong>Chat grouping is local.</strong> The Chat API still stores sessions
          without a project id, so the browser remembers which project each chat belongs
          to. Removing a project from the registry never deletes its root directory.
        </div>
      </div>
    </Modal>
  )
}
