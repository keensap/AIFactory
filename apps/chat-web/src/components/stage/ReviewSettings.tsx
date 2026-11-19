import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { ApiError, errorMessage, isAbortError, type ChatApi } from '../../api/client.ts'
import type { PlanningStageSettings, ResolvedStageSettings, StageKey } from '../../api/types.ts'
import { SETTING_ERROR_FIELDS, SETTING_LIMITS, parseSettingField, sameSettings, type SettingField } from '../../data/gates.ts'
import { Skeleton } from './StageBits.tsx'

export type ReviewSettingsScope = { kind: 'project'; projectId: string; stage?: StageKey } | { kind: 'factory' }

type Load =
  | { status: 'loading' }
  | { status: 'ready'; settings: ResolvedStageSettings }
  | { status: 'hidden' }
  | { status: 'disabled'; message: string }
  | { status: 'error'; message: string }

/**
 * Automatic review budget and acceptance thresholds for new runs.
 */
export function ReviewSettings({ api, scope, onHidden }: { api: ChatApi; scope: ReviewSettingsScope; onHidden?: () => void }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [values, setValues] = useState<Record<SettingField, string>>({ maxReviewCycles: '4', minRating: '94', maxBlockers: '0', maxMajor: '0' })
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SettingField, string>>>({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const baseId = useId()
  const scopeKey = scope.kind === 'project' ? JSON.stringify([scope.projectId, scope.stage ?? 'planning']) : 'factory'
  const isProject = scope.kind === 'project'

  const adopt = useCallback((settings: ResolvedStageSettings): void => {
    setLoad({ status: 'ready', settings })
    setValues({
      maxReviewCycles: String(settings.maxReviewCycles),
      minRating: String(settings.minRating),
      maxBlockers: String(settings.maxBlockers),
      maxMajor: String(settings.maxMajor),
    })
    setFieldErrors({})
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    setNotice(null)
    const request = scope.kind === 'project'
      ? api.getProjectStageSettings(scope.projectId, scope.stage ?? 'planning', controller.signal)
      : api.getStageDefaults(controller.signal)
    request.then((settings) => {
      if (!controller.signal.aborted) adopt(settings)
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return
      if (error instanceof ApiError && error.status === 501) setLoad({ status: 'hidden' })
      else if (error instanceof ApiError && (error.code === 'STAGE_SETTINGS_NOT_CONFIGURED' || error.status === 503)) {
        setLoad({ status: 'disabled', message: 'Stage settings need the database, which isn’t configured on this server.' })
      } else if (error instanceof ApiError && error.status === 404 && !isProject) setLoad({ status: 'hidden' })
      else setLoad({ status: 'error', message: errorMessage(error) })
    })
    return () => controller.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scopeKey, attempt, adopt])

  const wrap = (node: ReactNode): ReactNode => node

  if (load.status === 'hidden') return <Hidden onHidden={onHidden} />
  if (load.status === 'loading') return <Skeleton lines={5} />
  if (load.status === 'disabled') return <>{wrap(<p className="field-hint">{load.message}</p>)}</>
  if (load.status === 'error') {
    return wrap(
      <div className="settings-load-error">
        <p className="field-error" role="alert">Couldn’t load review settings. {load.message}</p>
        <button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
      </div>,
    )
  }

  const saved = load.settings
  const FIELDS: SettingField[] = ['maxReviewCycles', 'minRating', 'maxBlockers', 'maxMajor']
  const parsed = Object.fromEntries(FIELDS.map((field) => [field, parseSettingField(field, values[field])])) as Record<SettingField, ReturnType<typeof parseSettingField>>
  const valid = FIELDS.every((field) => 'value' in parsed[field])
  const num = (field: SettingField): number => {
    const result = parsed[field]
    return 'value' in result ? result.value : saved[field]
  }
  const draft: PlanningStageSettings = {
    maxReviewCycles: num('maxReviewCycles'),
    minRating: num('minRating'),
    maxBlockers: num('maxBlockers'),
    maxMajor: num('maxMajor'),
  }
  const dirty = !valid || !sameSettings(draft, saved)
  const setValue = (field: SettingField, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
  }

  const save = async (): Promise<void> => {
    if (!valid) {
      setFieldErrors(Object.fromEntries(FIELDS.flatMap((field) => {
        const result = parsed[field]
        return 'error' in result ? [[field, result.error]] : []
      })))
      return
    }
    setSaving(true)
    setFieldErrors({})
    setNotice(null)
    try {
      adopt(scope.kind === 'project' ? await api.updateProjectStageSettings(scope.projectId, scope.stage ?? 'planning', draft) : await api.updateStageDefaults(draft))
      setNotice('Saved. Applies to new runs.')
    } catch (error) {
      const field = error instanceof ApiError ? SETTING_ERROR_FIELDS[error.code] : undefined
      if (field !== undefined && error instanceof ApiError) setFieldErrors({ [field]: error.message })
      else if (error instanceof ApiError && error.code === 'INVALID_GATE_SETTING') setNotice(`Couldn’t save: ${error.message}`)
      else setNotice(`Couldn’t save: ${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const reset = async (): Promise<void> => {
    if (scope.kind !== 'project') return
    setSaving(true)
    setNotice(null)
    try {
      adopt(await api.resetProjectStageSettings(scope.projectId, scope.stage ?? 'planning'))
      setNotice('Back to the Factory default. Applies to new runs.')
    } catch (error) {
      setNotice(`Couldn’t reset: ${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const field = (key: SettingField, label: string, disabled: boolean, suffix: string): ReactNode => {
    const { min, max } = SETTING_LIMITS[key]
    const error = fieldErrors[key]
    return (
      <div className="setting-field">
        <label htmlFor={`${baseId}-${key}`}>{label}</label>
        <div className="setting-input">
          <input
            id={`${baseId}-${key}`}
            className="text-input review-number-input"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={values[key]}
            disabled={saving || disabled}
            aria-invalid={error !== undefined || undefined}
            aria-describedby={error === undefined ? undefined : `${baseId}-${key}-error`}
            onChange={(event) => setValue(key, event.target.value)}
          />
          <span className="field-hint">{suffix}</span>
        </div>
        {error !== undefined && <p className="field-error" id={`${baseId}-${key}-error`} role="alert">{error}</p>}
      </div>
    )
  }

  return <>{wrap(
    <div className="review-settings">
      <div className="review-settings-grid">
        {field('maxReviewCycles', 'Maximum write → review iterations', false, `${SETTING_LIMITS.maxReviewCycles.min}–${SETTING_LIMITS.maxReviewCycles.max}`)}
      </div>
      <p className="field-hint">How many times the writer may revise after a review before a person is asked.</p>

      <fieldset className="review-criteria">
        <legend>Ask for approval early when a review meets all of these</legend>
        <div className="review-settings-grid">
          {field('minRating', 'Overall rating at least', false, '0–100')}
          {field('maxBlockers', 'Blockers at most', false, '0–20')}
          {field('maxMajor', 'Major issues at most', false, '0–50')}
        </div>
        <p className="field-hint review-criteria-summary">
          {`Revision stops and you are asked for approval as soon as either happens: a review shows ≤ ${num('maxBlockers')} blocker${num('maxBlockers') === 1 ? '' : 's'}, ≤ ${num('maxMajor')} major issue${num('maxMajor') === 1 ? '' : 's'} and a rating of ${num('minRating')} or more, or ${num('maxReviewCycles')} iteration${num('maxReviewCycles') === 1 ? '' : 's'} have run.`}
        </p>
      </fieldset>

      <div className="review-settings-foot">
        <span className="chip review-source" data-source={isProject ? (saved.source ?? 'factory') : 'factory'}>
          {isProject ? `Effective: ${saved.source === 'project' ? 'Project override' : 'Factory default'}` : 'Factory default'}
        </span>
        <span className="review-settings-actions">
          {isProject && saved.source === 'project' && (
            <button type="button" className="button button-ghost button-sm" disabled={saving} onClick={() => void reset()}>
              Reset to Factory default
            </button>
          )}
          <button type="button" className="button button-primary button-sm" disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </span>
      </div>
      <p className="field-hint">Applies to new runs. A run that has already started keeps the settings it began with.</p>
      {notice !== null && <p className="field-hint" role="status">{notice}</p>}
    </div>,
  )}</>
}

/** Renders nothing; tells the parent the section isn't available on this API. */
function Hidden({ onHidden }: { onHidden: (() => void) | undefined }) {
  useEffect(() => onHidden?.(), [onHidden])
  return null
}
