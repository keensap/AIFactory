import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type {
  HumanDecision,
  ProjectDetail,
  SdlcStage,
  StageKey,
  StageRun,
  StageRunDetail,
} from '../api/types.ts'
import { ContextPanel } from '../components/stage/ContextPanel.tsx'
import { ActivityDrawer, CurrentActivityLine } from '../components/stage/Activity.tsx'
import { DecisionPanel, PartialOutputCard, PipelineCard, ReviewsCard } from '../components/stage/RunPanels.tsx'
import {
  CopyField,
  ProgressMeter,
  RunStatusChip,
  Skeleton,
  StageNotice,
  StageStatusChip,
  TimeAgo,
} from '../components/stage/StageBits.tsx'
import { StageRail } from '../components/stage/StageRail.tsx'
import { TelosDocument } from '../components/stage/TelosDocument.tsx'
import { ArrowLeftIcon, ListIcon, MessageIcon, MoonIcon, PencilIcon, RefreshIcon, SettingsIcon, SunIcon } from '../components/Icons.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { loadBrief, saveBrief } from '../data/briefs.ts'
import { runLogsHref } from '../data/logs.ts'
import type { Project } from '../data/projects.ts'
import { describeStageError, type StageErrorView } from '../data/stageErrors.ts'
import {
  advanceBlock,
  checklistLabelsFromError,
  DECISION_LABEL,
  EXECUTABLE_STAGES,
  failedRole,
  failureMessage,
  isCycleLimit,
  isExecuting,
  isPollable,
  isStageKey,
  MAX_BRIEF_CHARS,
  nextStageKey,
  recordedDecision,
  requiredProgress,
  runStatusLabel,
  sortStages,
  stageChecklist,
  stageName,
  telosDocument,
  FALLBACK_STAGES,
  type PipelineStepKey,
} from '../data/stages.ts'
import { healthLabel } from '../components/AppHeader.tsx'
import type { ApiHealthController } from '../hooks/useApiHealth.ts'
import { useStageRun } from '../hooks/useStageRun.ts'
import { useRunEvents } from '../hooks/useRunEvents.ts'
import { buildTimeline, DEFAULT_FILTERS, roleSummaries, type ActivityFilters } from '../data/activity.ts'
import type { StorageLike } from '../lib/storage.ts'
import { navigate, routeHref } from '../lib/router.ts'

export interface StageWorkspaceProps {
  api: ChatApi
  storage: StorageLike
  project: Project
  routeStage: string
  routeRunId: string | null
  health: ApiHealthController
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onOpenSettings: () => void
  onEditProject: () => void
  /** The project's stage changed (refreshes the project list). */
  onProjectChanged: () => void
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: unknown }

const PLANNING: StageKey = 'planning'

/**
 * Stage-centric project workspace: project header, stage rail, the stage
 * workspace (Planning & Feasibility is executable) and a context panel.
 */
export function StageWorkspace({
  api,
  storage,
  project,
  routeStage,
  routeRunId,
  health,
  theme,
  onToggleTheme,
  onOpenSettings,
  onEditProject,
  onProjectChanged,
  onNotify,
}: StageWorkspaceProps) {
  const projectId = project.id
  const [stages, setStages] = useState<SdlcStage[]>([...FALLBACK_STAGES])
  const [detail, setDetail] = useState<Loadable<ProjectDetail>>({ status: 'loading' })
  const [runs, setRuns] = useState<Loadable<StageRun[]>>({ status: 'loading' })
  const [tab, setTab] = useState<'workspace' | 'chat'>('workspace')

  // --- Loading -------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController()
    api.listSdlcStages(controller.signal)
      .then((list) => {
        if (list.length > 0) setStages(sortStages(list))
      })
      .catch(() => {
        // Fallback names stay in place.
      })
    return () => controller.abort()
  }, [api])

  const detailController = useRef<AbortController | null>(null)
  const loadDetail = useCallback(async (): Promise<void> => {
    detailController.current?.abort()
    const controller = new AbortController()
    detailController.current = controller
    try {
      const value = await api.getProjectDetail(projectId, controller.signal)
      if (!controller.signal.aborted) setDetail({ status: 'ready', value })
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      setDetail((current) => (current.status === 'ready' ? current : { status: 'error', error }))
      if (!(error instanceof ApiError && error.status === 0)) return
      onNotify('Couldn’t refresh the project: API unavailable.', 'error')
    }
  }, [api, projectId, onNotify])

  const runsController = useRef<AbortController | null>(null)
  const loadRuns = useCallback(async (): Promise<void> => {
    runsController.current?.abort()
    const controller = new AbortController()
    runsController.current = controller
    try {
      const value = await api.listStageRuns(projectId, PLANNING, controller.signal)
      if (!controller.signal.aborted) setRuns({ status: 'ready', value })
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      setRuns((current) => (current.status === 'ready' ? current : { status: 'error', error }))
    }
  }, [api, projectId])

  useEffect(() => {
    void loadDetail()
    void loadRuns()
    return () => {
      detailController.current?.abort()
      runsController.current?.abort()
    }
  }, [loadDetail, loadRuns])

  const refreshAll = useCallback(() => {
    void loadDetail()
    void loadRuns()
  }, [loadDetail, loadRuns])

  const runIdForStage = routeStage === PLANNING ? routeRunId : null
  const poller = useStageRun(api, runIdForStage, refreshAll)
  const run = poller.run !== null && poller.run.id === runIdForStage ? poller.run : null
  const pollingRef = useRef(poller.polling)
  pollingRef.current = poller.polling

  // Activity log: one reader per run. Live while the run can still emit events
  // (incl. awaiting_human, for the later human_decision); terminal runs load
  // the persisted log only. `event: end` refreshes the run instead of
  // trusting the last event.
  const runLive = run === null ? null : isPollable(run.status) || run.status === 'awaiting_human'
  const onActivityEnd = useCallback(() => {
    refreshAll()
    if (!pollingRef.current) poller.resume()
  }, [refreshAll, poller.resume])
  const activityLog = useRunEvents(api, runIdForStage, runLive, onActivityEnd)
  const [activityOpen, setActivityOpen] = useState(false)
  const [activityFilters, setActivityFilters] = useState<ActivityFilters>(DEFAULT_FILTERS)
  useEffect(() => {
    setActivityOpen(false)
    setActivityFilters(DEFAULT_FILTERS)
  }, [runIdForStage])

  // --- Derived ---------------------------------------------------------------

  const projectDetail = detail.status === 'ready' ? detail.value : null
  const apiProject = projectDetail?.project ?? null
  const sdlc = projectDetail?.sdlc
  const currentStage = sdlc?.currentStage ?? apiProject?.currentStage ?? project.currentStage ?? PLANNING
  const checklist = sdlc?.checklist ?? null
  const viewedChecklist = checklist === null ? null : stageChecklist(checklist, routeStage)
  const stageDocuments = projectDetail === null ? null : (projectDetail.documents ?? []).filter((document) => document.stage === routeStage)
  const runList = runs.status === 'ready' ? runs.value : null
  const latestRun = runList?.[0] ?? null
  const anyRunActive = (runList ?? []).some((entry) => isPollable(entry.status) && entry.status !== 'pending')
    || (run !== null && isExecuting(run.status))
  const knownStage = isStageKey(stages, routeStage)
  const stageLabel = stageName(stages, routeStage)
  const stageState = sdlc?.stages.find((entry) => entry.stage === routeStage)
  const completedStages = sdlc?.stages.filter((entry) => entry.status === 'completed').length ?? 0
  const allRequired = checklist === null ? null : requiredProgress(checklist)
  const viewedProgress = viewedChecklist === null ? null : requiredProgress(viewedChecklist)
  const next = nextStageKey(stages, routeStage)

  useEffect(() => {
    document.title = `${stageLabel} · ${project.name} — AI Factory Chat`
  }, [stageLabel, project.name])

  // --- Brief draft (survives navigation) ------------------------------------

  const [brief, setBriefState] = useState<string>(() => loadBrief(storage, projectId) ?? '')
  const briefSeeded = useRef(loadBrief(storage, projectId) !== null)
  const setBrief = useCallback((value: string) => {
    briefSeeded.current = true
    setBriefState(value)
    saveBrief(storage, projectId, value)
  }, [storage, projectId])
  // No saved draft: prefill a retry with the last run's brief.
  useEffect(() => {
    if (briefSeeded.current || latestRun?.inputText == null) return
    briefSeeded.current = true
    setBriefState(latestRun.inputText)
  }, [latestRun])

  // --- Actions ---------------------------------------------------------------

  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<StageErrorView | null>(null)
  const [executeRequested, setExecuteRequested] = useState<ReadonlySet<string>>(new Set())
  const [executeNotice, setExecuteNotice] = useState<{ runId: string; view: StageErrorView } | null>(null)

  const execute = useCallback(async (runId: string): Promise<void> => {
    setExecuteRequested((current) => new Set(current).add(runId))
    setExecuteNotice(null)
    try {
      const started = await api.executeStageRun(runId)
      poller.replace(started)
    } catch (error) {
      const view = describeStageError(error)
      setExecuteNotice({ runId, view })
    } finally {
      // One poller per run: restart it only if it has stopped (a still-running
      // loop picks up the new status on its next tick).
      if (!pollingRef.current) poller.resume()
      void loadRuns()
    }
  }, [api, poller.replace, poller.resume, loadRuns])

  const startRun = async (): Promise<void> => {
    if (starting) return
    setStarting(true)
    setStartError(null)
    try {
      const created = await api.createStageRun(projectId, PLANNING, { brief: brief.trim() })
      setRuns((current) => (current.status === 'ready'
        ? { status: 'ready', value: [created, ...current.value.filter((entry) => entry.id !== created.id)] }
        : current))
      navigate({ name: 'stage', projectId, stage: PLANNING, runId: created.id })
      await execute(created.id)
    } catch (error) {
      setStartError(describeStageError(error))
    } finally {
      setStarting(false)
    }
  }

  const [deciding, setDeciding] = useState(false)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const decide = async (decision: HumanDecision, note: string): Promise<void> => {
    if (run === null) return
    setDeciding(true)
    setDecisionError(null)
    try {
      const updated = await api.decideStageRun(run.id, { decision, ...(note.trim() === '' ? {} : { note: note.trim() }) })
      poller.replace(updated)
      onNotify(`${DECISION_LABEL[decision]} recorded`, 'success')
      refreshAll()
    } catch (error) {
      const view = describeStageError(error)
      setDecisionError(`${view.title}. ${view.message}`)
      if (view.kind === 'awaiting-human') poller.resume()
    } finally {
      setDeciding(false)
    }
  }

  const [advancing, setAdvancing] = useState(false)
  const [advanceError, setAdvanceError] = useState<{ view: StageErrorView; labels: string[] } | null>(null)
  const advance = async (): Promise<void> => {
    if (next === null) return
    setAdvancing(true)
    setAdvanceError(null)
    try {
      await api.advanceStage(projectId, next)
      onNotify(`${project.name} moved to ${stageName(stages, next)}`, 'success')
      await loadDetail()
      onProjectChanged()
      navigate({ name: 'stage', projectId, stage: next, runId: null })
    } catch (error) {
      const view = describeStageError(error)
      const labels = view.kind === 'checklist-incomplete' && error instanceof ApiError ? checklistLabelsFromError(error.message) : []
      setAdvanceError({ view, labels })
      void loadDetail()
    } finally {
      setAdvancing(false)
    }
  }

  const focusChecklist = (): void => {
    const target = document.getElementById('stage-checklist')
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    target?.focus({ preventScroll: true })
  }

  // --- Render ----------------------------------------------------------------

  const detailErrorView = detail.status === 'error' ? describeStageError(detail.error) : null
  if (detailErrorView?.kind === 'not-found') {
    return (
      <div className="stage-page">
        <main className="page-main page-narrow">
          <div className="section-empty">
            <p><strong>Project not found.</strong> It may have been deleted.</p>
            <a className="back-link" href={routeHref({ name: 'home' })}><ArrowLeftIcon size={15} /> All projects</a>
          </div>
        </main>
      </div>
    )
  }

  const offline = health.state.status === 'offline'
  const unauthorized = health.state.status === 'unauthorized' || detailErrorView?.kind === 'unauthorized'
  const noRuntime = projectDetail !== null && projectDetail.sdlc === undefined
  const rootPath = apiProject?.rootPath ?? project.workspace

  const gate = advanceBlock({
    currentStage,
    viewedStage: routeStage,
    run: run ?? (latestRun?.status === 'completed' ? latestRun : null),
    checklist: checklist ?? [],
    nextStage: next,
  })
  const gateRun = run ?? latestRun

  const advanceCard = routeStage === PLANNING && gateRun !== null && gateRun.status === 'completed' && currentStage === PLANNING && next !== null && recordedDecision(gateRun) !== 'no_go' ? (
    <section className="stage-card advance-card" aria-labelledby="advance-title">
      <header className="stage-card-head stage-card-head-compact">
        <div>
          <span className="eyebrow">Stage gate</span>
          <h3 id="advance-title">Advance to {stageName(stages, next)}</h3>
        </div>
      </header>
      <p className="field-hint">
        {gate === null
          ? 'All required Planning items are done. Advancing completes Planning and starts the next stage.'
          : gate === 'checklist-open'
            ? 'Some required checklist items are still open.'
            : 'Advancing needs a completed run with a go or conditional-go decision.'}
      </p>
      {advanceError !== null && (
        <StageNotice error={advanceError.view}>
          {advanceError.labels.length > 0 && (
            <>
              <ul className="missing-items">{advanceError.labels.map((label) => <li key={label}>{label}</li>)}</ul>
              <button type="button" className="text-button" onClick={focusChecklist}>Review the checklist</button>
            </>
          )}
        </StageNotice>
      )}
      <div className="stage-card-foot">
        {gate === 'checklist-open' && <button type="button" className="text-button" onClick={focusChecklist}>Open checklist</button>}
        <button type="button" className="button button-primary" disabled={gate !== null || advancing} onClick={() => void advance()}>
          {advancing ? 'Advancing…' : `Advance to ${stageName(stages, next)}`}
        </button>
      </div>
    </section>
  ) : null

  return (
    <div className="stage-page">
      <ProjectStageHeader
        project={project}
        rootPath={rootPath}
        status={apiProject?.status ?? project.status}
        currentStageName={projectDetail === null ? null : stageName(stages, currentStage)}
        completedStages={projectDetail === null ? null : completedStages}
        totalStages={stages.length}
        required={allRequired}
        health={health}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onOpenSettings={onOpenSettings}
        onEditProject={onEditProject}
      />

      {(offline || unauthorized) && (
        <div className="stage-banner" data-tone={offline ? 'error' : 'warning'} role="alert">
          <strong>{offline ? 'API unavailable' : 'Session expired or token missing'}</strong>
          <span>{offline ? 'Your brief is kept. Retry once the Chat API is running.' : 'Add a valid bearer token in Settings, then retry.'}</span>
          {unauthorized && <button type="button" className="button button-ghost button-sm" onClick={onOpenSettings}>Settings</button>}
          <button type="button" className="button button-ghost button-sm" onClick={() => {
            void health.refresh()
            refreshAll()
            if (runIdForStage !== null) poller.resume()
          }}>
            <RefreshIcon size={14} /> Retry
          </button>
        </div>
      )}

      <div className="stage-layout">
        {sdlc === undefined ? (
          <div className="stage-rail stage-rail-loading">{detail.status === 'loading' ? <Skeleton lines={8} /> : null}</div>
        ) : (
          <StageRail
            projectId={projectId}
            stages={stages}
            states={sdlc.stages}
            checklist={sdlc.checklist}
            currentStage={currentStage}
            selectedStage={routeStage}
          />
        )}

        <main className="stage-main" aria-labelledby="stage-title">
          <header className="stage-head">
            <div className="stage-head-row">
              <div className="stage-head-copy">
                <span className="eyebrow">Stage {Math.max(1, stages.findIndex((stage) => stage.key === routeStage) + 1)} of {stages.length}</span>
                <h1 id="stage-title">{stageLabel}</h1>
              </div>
              <div className="stage-head-meta">
                {stageState !== undefined && <StageStatusChip status={stageState.status} />}
                {viewedProgress !== null && viewedProgress.total > 0 && <ProgressMeter done={viewedProgress.done} total={viewedProgress.total} label="Required items done" />}
                {run !== null && <RunStatusChip status={run.status} />}
              </div>
            </div>
            {routeStage === PLANNING && (
              <p className="stage-head-lede">Validate the business idea and assess Technical, Economic, Legal, Operational and Schedule feasibility.</p>
            )}
            <div className="stage-tabs" role="tablist" aria-label="Stage views">
              <button type="button" role="tab" className="stage-tab" aria-selected={tab === 'workspace'} onClick={() => setTab('workspace')}>Workspace</button>
              <button type="button" role="tab" className="stage-tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
            </div>
          </header>

          <div className="stage-body" role="tabpanel">
            {tab === 'chat' ? (
              <div className="stage-card stage-placeholder">
                <MessageIcon size={20} />
                <p>Stage chat is coming next. For now, use the brief and the run review to discuss this stage.</p>
              </div>
            ) : detail.status === 'loading' ? (
              <>
                <Skeleton lines={3} className="stage-card" />
                <Skeleton lines={5} className="stage-card" />
              </>
            ) : detailErrorView !== null && projectDetail === null ? (
              <StageNotice error={detailErrorView} {...(detailErrorView.kind === 'unauthorized' ? {} : { onRetry: refreshAll })} />
            ) : noRuntime ? (
              <StageNotice
                tone="info"
                error={{ title: 'Stage runtime not available', message: 'This Chat API doesn’t expose SDLC stages. Update apps/chat-cli, or use the project chat.' }}
              >
                <a className="text-button" href={routeHref({ name: 'project', projectId, sessionId: null })}>Open project chat</a>
              </StageNotice>
            ) : !knownStage ? (
              <StageNotice error={{ title: 'Stage not found', message: `“${routeStage}” isn’t an SDLC stage.` }}>
                <a className="text-button" href={routeHref({ name: 'stage', projectId, stage: currentStage, runId: null })}>Go to the current stage</a>
              </StageNotice>
            ) : !EXECUTABLE_STAGES.has(routeStage) ? (
              <ReadOnlyStage stageName={stageLabel} isCurrent={routeStage === currentStage} />
            ) : (
              <PlanningWorkspace
                api={api}
                projectId={projectId}
                run={run}
                runId={runIdForStage}
                poller={poller}
                activity={{
                  log: activityLog,
                  open: activityOpen,
                  setOpen: setActivityOpen,
                  filters: activityFilters,
                  setFilters: setActivityFilters,
                }}
                runs={runs}
                brief={brief}
                onBriefChange={setBrief}
                starting={starting}
                startError={startError}
                startDisabled={anyRunActive}
                onStart={() => void startRun()}
                executeRequested={runIdForStage !== null && executeRequested.has(runIdForStage)}
                executeNotice={executeNotice !== null && executeNotice.runId === runIdForStage ? executeNotice.view : null}
                onExecute={(id) => void execute(id)}
                deciding={deciding}
                decisionError={decisionError}
                onDecide={(decision, note) => void decide(decision, note)}
                advanceCard={advanceCard}
                onRetryRuns={() => void loadRuns()}
                onNotify={onNotify}
              />
            )}
          </div>
        </main>

        {projectDetail === null ? (
          <aside className="context-panel">{detail.status === 'loading' ? <Skeleton lines={8} /> : null}</aside>
        ) : (
          <ContextPanel
            api={api}
            project={projectDetail.project}
            checklist={viewedChecklist}
            documents={run !== null ? run.documents : stageDocuments}
            run={run ?? (routeStage === PLANNING ? latestRun : null)}
            latestRun={routeStage === PLANNING ? latestRun : null}
            stage={routeStage}
            onNotify={onNotify}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function ProjectStageHeader({
  project,
  rootPath,
  status,
  currentStageName,
  completedStages,
  totalStages,
  required,
  health,
  theme,
  onToggleTheme,
  onOpenSettings,
  onEditProject,
}: {
  project: Project
  rootPath: string
  status: string | undefined
  currentStageName: string | null
  completedStages: number | null
  totalStages: number
  required: { done: number; total: number } | null
  health: ApiHealthController
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onOpenSettings: () => void
  onEditProject: () => void
}) {
  return (
    <header className="stage-project-header">
      <a className="back-link stage-back" href={routeHref({ name: 'home' })} aria-label="All projects" title="All projects">
        <ArrowLeftIcon size={16} />
      </a>
      <div className="stage-project-id">
        <div className="stage-project-title">
          <h2>{project.name}</h2>
          {status !== undefined && <span className="chip project-status-chip" data-status={status}><span className="chip-glyph" aria-hidden="true" />{status}</span>}
          {currentStageName !== null && <span className="chip stage-badge">Stage: {currentStageName}</span>}
        </div>
        {rootPath !== '' && <CopyField value={rootPath} label="root path" />}
      </div>
      <div className="stage-project-progress">
        {completedStages === null ? <Skeleton lines={1} /> : (
          <>
            <span><strong>{completedStages}</strong>/{totalStages} stages</span>
            {required !== null && <span><strong>{required.done}</strong>/{required.total} required items</span>}
          </>
        )}
      </div>
      <div className="stage-project-actions">
        <a className="button button-ghost button-sm" href={routeHref({ name: 'project', projectId: project.id, sessionId: null })}>
          <MessageIcon size={14} /> Project chat
        </a>
        <a className="button button-ghost button-sm" href={routeHref({ name: 'logs', projectId: project.id, search: '' })}>
          <ListIcon size={14} /> Logs
        </a>
        <button type="button" className="icon-button" aria-label="Edit project" title="Edit project" onClick={onEditProject}>
          <PencilIcon size={16} />
        </button>
        <button type="button" className="health-pill" data-status={health.state.status} onClick={onOpenSettings} title={health.state.error ?? 'Connection settings'}>
          <span className="status-dot" aria-hidden="true" />
          {healthLabel(health.state)}
        </button>
        <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
          <SettingsIcon size={16} />
        </button>
        <button type="button" className="icon-button" onClick={onToggleTheme} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
        </button>
      </div>
    </header>
  )
}

function ReadOnlyStage({ stageName: name, isCurrent }: { stageName: string; isCurrent: boolean }) {
  return (
    <div className="stage-card stage-readonly">
      <span className="chip run-chip" data-status="cancelled"><span className="chip-glyph" aria-hidden="true" />Read-only</span>
      <h3>Runtime not implemented yet</h3>
      <p>
        {name} can’t be executed from the UI yet. {isCurrent
          ? 'This is the project’s current stage; its checklist and documents are on the right.'
          : 'Its checklist and documents are shown on the right.'} Only Planning &amp; Feasibility runs today.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface PlanningWorkspaceProps {
  api: ChatApi
  projectId: string
  run: StageRunDetail | null
  runId: string | null
  poller: ReturnType<typeof useStageRun>
  activity: {
    log: ReturnType<typeof useRunEvents>
    open: boolean
    setOpen: (open: boolean) => void
    filters: ActivityFilters
    setFilters: (filters: ActivityFilters) => void
  }
  runs: Loadable<StageRun[]>
  brief: string
  onBriefChange: (value: string) => void
  starting: boolean
  startError: StageErrorView | null
  startDisabled: boolean
  onStart: () => void
  executeRequested: boolean
  executeNotice: StageErrorView | null
  onExecute: (runId: string) => void
  deciding: boolean
  decisionError: string | null
  onDecide: (decision: HumanDecision, note: string) => void
  advanceCard: ReactNode
  onRetryRuns: () => void
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

function PlanningWorkspace(props: PlanningWorkspaceProps) {
  const { run, runId, poller, runs, activity } = props
  const runList = runs.status === 'ready' ? runs.value : null
  const runActive = run !== null && (isPollable(run.status) || run.status === 'awaiting_human')
  // Memoized per event batch; also feeds the pipeline step badges.
  const roleTotals = useMemo(() => roleSummaries(buildTimeline(activity.log.events, runActive)), [activity.log.events, runActive])

  if (runId === null) {
    return (
      <>
        {props.advanceCard}
        <BriefCard {...props} title={runList !== null && runList.length > 0 ? 'Start a new attempt' : 'Business brief'} />
        <RunHistory projectId={props.projectId} runs={runs} activeRunId={null} onRetry={props.onRetryRuns} />
      </>
    )
  }

  const loadError = poller.error === null ? null : describeStageError(poller.error)
  if (run === null) {
    return poller.loading || loadError === null ? (
      <>
        <Skeleton lines={2} className="stage-card" />
        <Skeleton lines={4} className="stage-card" />
      </>
    ) : (
      <StageNotice error={loadError} {...(loadError.kind === 'not-found' || loadError.kind === 'unauthorized' ? {} : { onRetry: poller.resume })}>
        <a className="text-button" href={routeHref({ name: 'stage', projectId: props.projectId, stage: PLANNING, runId: null })}>Back to Planning</a>
      </StageNotice>
    )
  }

  const failure = failureMessage(run)
  const cycleLimit = isCycleLimit(run)
  const role = failedRole(run)
  const stopped = run.status === 'failed' || run.status === 'cancelled'
  const decision = recordedDecision(run)
  const telos = telosDocument(run.documents)
  function openActivity(role: PipelineStepKey | null): void {
    // A step opens the drawer filtered to that role; the button/line shows everything.
    activity.setFilters(role === null ? { ...activity.filters, role: 'all' } : { ...DEFAULT_FILTERS, role })
    activity.setOpen(true)
  }
  function revealCard(selector: string): void {
    // The mobile sheet covers the page; close it before scrolling.
    if (window.matchMedia('(max-width: 820px)').matches) activity.setOpen(false)
    const card = document.querySelector<HTMLElement>(selector)
    if (card === null) return
    card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
    card.querySelector<HTMLElement>('h3')?.setAttribute('tabindex', '-1')
    card.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })
  }
  const offerRetry = run.status === 'failed' || run.status === 'cancelled' || decision === 'no_go' || props.executeNotice?.kind === 'terminal'

  return (
    <>
      <section className="stage-card run-card" aria-labelledby="run-title">
        <header className="stage-card-head stage-card-head-compact">
          <div>
            <span className="eyebrow">Stage run</span>
            <h3 id="run-title">Attempt {run.attempt}</h3>
          </div>
          <div className="run-card-actions">
            <button
              type="button"
              className="button button-small activity-button"
              aria-expanded={activity.open}
              aria-controls="run-activity"
              onClick={() => openActivity(null)}
            >
              <span className="activity-conn-dot" data-state={activity.log.connection} aria-hidden="true" />
              Activity
            </button>
            <RunStatusChip status={run.status} />
          </div>
        </header>
        <p className="run-times">
          <TimeAgo iso={run.createdAt} prefix="Created" />
          {run.startedAt !== null && <> · <TimeAgo iso={run.startedAt} prefix="started" /></>}
          {run.completedAt !== null && <> · <TimeAgo iso={run.completedAt} prefix="finished" /></>}
          {poller.polling && <span className="run-polling"> · updating…</span>}
        </p>
        <p className="sr-only" aria-live="polite">Run status: {runStatusLabel(run.status)}</p>
        <CurrentActivityLine events={activity.log.events} connection={activity.log.connection} expanded={activity.open} onOpen={() => openActivity(null)} />

        {run.status === 'pending' && !props.executeRequested && (
          <div className="stage-card-foot">
            <span className="field-hint">This run is queued but hasn’t been started.</span>
            <button type="button" className="button button-primary" onClick={() => props.onExecute(run.id)}>Start execution</button>
          </div>
        )}
        {props.executeNotice !== null && (
          <StageNotice error={props.executeNotice} tone={props.executeNotice.kind === 'running' ? 'info' : 'error'} />
        )}
        {loadError !== null && (
          <StageNotice error={{ title: 'Couldn’t refresh the run', message: loadError.message }} tone="warning" {...(poller.polling ? {} : { onRetry: poller.resume })} />
        )}
        {poller.timedOut && (
          <StageNotice tone="warning" error={{ title: 'Taking longer than expected', message: 'Stopped checking after 30 minutes. The run may still be working on the server.' }} onRetry={poller.resume} />
        )}
        {failure !== null && (
          <StageNotice error={{
            title: cycleLimit ? 'Cycle limit reached' : role !== null ? `${role.label} failed` : 'The model run failed',
            message: role !== null ? role.message : failure,
          }}>
            <p className="field-hint">
              A failed run can’t be re-executed. Start a new attempt below; your brief is kept.
              {(run.analysisMarkdown || run.draftMarkdown) ? ' The work saved before the failure is shown under Partial output.' : ''}
            </p>
          </StageNotice>
        )}
        {decision !== null && (
          <div className="decision-recorded" data-decision={decision}>
            <strong>{decision === 'no_go' ? 'No-go recorded' : `Decision: ${DECISION_LABEL[decision]}`}</strong>
            {decision === 'no_go' && <span>The project stays in Planning. Revise the brief and start a new attempt if needed.</span>}
          </div>
        )}
      </section>

      <PipelineCard
        run={run}
        lastSeenStep={poller.lastSeenStep}
        activity={{ summaries: roleTotals, onOpen: (role) => openActivity(role), openRole: activity.open ? (activity.filters.role === 'all' || activity.filters.role === 'run' ? null : activity.filters.role) : null }}
      />

      {run.status === 'awaiting_human' && (
        <DecisionPanel busy={props.deciding} error={props.decisionError} onDecide={props.onDecide} />
      )}

      {props.advanceCard}

      <ReviewsCard reviews={run.reviews} cycleLimit={cycleLimit} />

      {stopped && <PartialOutputCard run={run} />}

      {telos !== undefined ? (
        <TelosDocument api={props.api} document={telos} onNotify={props.onNotify} />
      ) : (
        <section className="stage-card">
          <header className="stage-card-head stage-card-head-compact"><h3>TELOS feasibility report</h3></header>
          <p className="section-empty-inline">
            {isPollable(run.status)
              ? 'The report appears here after the reviewer approves it.'
              : stopped && (run.analysisMarkdown || run.draftMarkdown)
                ? 'No approved report was stored for this run. See Partial output above for the saved draft.'
                : 'No report was stored for this run.'}
          </p>
        </section>
      )}

      {run.summaryMarkdown !== null && run.summaryMarkdown.trim() !== '' && failure === null && (
        <details className="stage-card run-summary">
          <summary>Run summary</summary>
          <Markdown>{run.summaryMarkdown}</Markdown>
        </details>
      )}

      <details className="stage-card brief-disclosure" open={offerRetry || undefined}>
        <summary>Start a new attempt</summary>
        <BriefCard {...props} title={null} />
      </details>

      <RunHistory projectId={props.projectId} runs={runs} activeRunId={run.id} onRetry={props.onRetryRuns} />

      <ActivityDrawer
        open={activity.open}
        onClose={() => activity.setOpen(false)}
        attempt={run.attempt}
        log={activity.log}
        runActive={runActive}
        filters={activity.filters}
        onFiltersChange={activity.setFilters}
        onShowReviews={() => revealCard('.reviews-card')}
        onShowDocument={() => revealCard('.telos-card')}
        logsHref={runLogsHref(run.projectId, run.id, activity.filters)}
      />
    </>
  )
}

function BriefCard({
  brief,
  onBriefChange,
  starting,
  startError,
  startDisabled,
  onStart,
  title,
}: PlanningWorkspaceProps & { title: string | null }) {
  const id = useId()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const over = brief.length > MAX_BRIEF_CHARS
  const disabled = starting || startDisabled

  // Autosize up to a cap; past it the textarea scrolls.
  useEffect(() => {
    const area = textareaRef.current
    if (area === null) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight + 2, 520)}px`
  }, [brief])

  const body = (
    <form
      className="brief-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!over && !disabled) onStart()
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor={id}>Business idea and stakeholder goals</label>
        <p className="field-hint" id={`${id}-help`}>
          Describe the problem, target users, business idea, stakeholder goals, success measures and known constraints.
          The analyzer will turn this into a TELOS feasibility report.
        </p>
        <textarea
          ref={textareaRef}
          id={id}
          className="text-input text-area brief-textarea"
          aria-describedby={`${id}-help ${id}-meta`}
          value={brief}
          disabled={disabled}
          rows={6}
          onChange={(event) => onBriefChange(event.target.value)}
          aria-invalid={over || undefined}
        />
        <div className="intake-meta" id={`${id}-meta`}>
          {over
            ? <span className="field-error">Keep the brief under {MAX_BRIEF_CHARS.toLocaleString()} characters.</span>
            : brief.trim() === ''
              ? <span className="field-warning">Empty brief: the report will be based only on project metadata.</span>
              : <span className="field-hint">Saved in this browser until you start a run.</span>}
          <span className="field-hint" data-over={over || undefined}>{brief.length.toLocaleString()} / {MAX_BRIEF_CHARS.toLocaleString()}</span>
        </div>
      </div>
      {startError !== null && <StageNotice error={startError} />}
      <div className="stage-card-foot">
        {startDisabled && <span className="field-hint">A run is executing. Wait for it to finish.</span>}
        <button type="submit" className="button button-primary" disabled={disabled || over}>
          {starting ? 'Starting…' : 'Start planning run'}
        </button>
      </div>
    </form>
  )

  if (title === null) return body
  return (
    <section className="stage-card brief-card" aria-label={title}>
      <header className="stage-card-head stage-card-head-compact"><h3>{title}</h3></header>
      {body}
    </section>
  )
}

function RunHistory({ projectId, runs, activeRunId, onRetry }: { projectId: string; runs: Loadable<StageRun[]>; activeRunId: string | null; onRetry: () => void }) {
  return (
    <section className="stage-card run-history" aria-labelledby="run-history-title">
      <header className="stage-card-head stage-card-head-compact"><h3 id="run-history-title">Run history</h3></header>
      {runs.status === 'loading' ? <Skeleton lines={2} /> : runs.status === 'error' ? (
        <StageNotice error={describeStageError(runs.error)} onRetry={onRetry} />
      ) : runs.value.length === 0 ? (
        <p className="section-empty-inline">No planning runs yet.</p>
      ) : (
        <ol className="run-history-list">
          {runs.value.map((entry) => (
            <li key={entry.id}>
              <a
                className="run-history-row"
                href={routeHref({ name: 'stage', projectId, stage: PLANNING, runId: entry.id })}
                aria-current={entry.id === activeRunId ? 'page' : undefined}
              >
                <span className="run-history-attempt">Attempt {entry.attempt}</span>
                <RunStatusChip status={entry.status} />
                <span className="run-history-time"><TimeAgo iso={entry.updatedAt} prefix="updated" /></span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
