import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, isAbortError, type ChatApi } from '../api/client.ts'
import type {
  HumanDecision,
  RequirementsDecisionInput,
  ProjectDetail,
  SdlcStage,
  StageKey,
  StageRun,
  StageRunDetail,
  SessionSummary,
} from '../api/types.ts'
import { ArtifactsCard } from '../components/stage/ArtifactsCard.tsx'
import { ContextPanel } from '../components/stage/ContextPanel.tsx'
import { StageChatDock } from '../components/chat/StageChatDock.tsx'
import { buildStageContext } from '../data/stageChat.ts'
import { ProjectPanel } from '../components/stage/ProjectPanel.tsx'
import { StatusBar } from '../components/StatusBar.tsx'
import { ActivityDrawer, CurrentActivityLine } from '../components/stage/Activity.tsx'
import { FinalGatePanel, RequirementsFinalGatePanel } from '../components/stage/GatePanels.tsx'
import { exportFailure } from '../data/attachments.ts'
import { AttachmentsField } from '../components/stage/AttachmentsField.tsx'
import { useStageAttachments, type StageAttachments } from '../hooks/useStageAttachments.ts'
import { StageSettingsDialog } from '../components/stage/StageSettingsDialog.tsx'
import { gateOf, requirementsRejectionRecorded, STALE_GATE_CODES } from '../data/gates.ts'
import { DecisionPanel, PartialOutputCard, PipelineCard, ReviewsCard } from '../components/stage/RunPanels.tsx'
import {
  ProgressMeter,
  RunStatusChip,
  Skeleton,
  StageNotice,
  StageStatusChip,
  TimeAgo,
} from '../components/stage/StageBits.tsx'
import { StageBar } from '../components/stage/StageBar.tsx'
import { StageDocument } from '../components/stage/TelosDocument.tsx'
import { ArrowLeftIcon, InfoIcon, RefreshIcon, SettingsIcon } from '../components/Icons.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { loadBrief, saveBrief } from '../data/briefs.ts'
import { runLogsHref } from '../data/logs.ts'
import { buildStageBar, isHistoricalStage, stageBarSummary } from '../data/stageBar.ts'
import { useStatusBarData } from '../hooks/useStatusBarData.ts'
import type { Project } from '../data/projects.ts'
import { describeStageError, type StageErrorView } from '../data/stageErrors.ts'
import {
  advanceBlock,
  checklistLabelsFromError,
  DECISION_LABEL,
  isExecutableStage,
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
  stageArtifact,
  stageArtifactTitle,
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
  sessions: SessionSummary[]
  onSessionStarted: (session: SessionSummary, projectId: string) => void
  onRefreshSessions: () => Promise<void>
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

type Loadable<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: unknown }

const PLANNING: StageKey = 'planning'

/**
 * Stage-centric project workspace: project header, stage rail, the stage
 * workspace for executable stages and a context panel.
 */
export function StageWorkspace({
  api,
  storage,
  project,
  routeStage,
  routeRunId,
  health,
  onOpenSettings,
  onEditProject,
  onProjectChanged,
  sessions,
  onSessionStarted,
  onRefreshSessions,
  onNotify,
}: StageWorkspaceProps) {
  const projectId = project.id
  const [stages, setStages] = useState<SdlcStage[]>([...FALLBACK_STAGES])
  const [detail, setDetail] = useState<Loadable<ProjectDetail>>({ status: 'loading' })
  const [runs, setRuns] = useState<Loadable<StageRun[]>>({ status: 'loading' })

  const runtimeStage = routeStage === 'planning' || routeStage === 'requirements' ? routeStage : null
  const executable = runtimeStage !== null && isExecutableStage(stages, runtimeStage)

  // --- Loading -------------------------------------------------------------

  useEffect(() => {
    const controller = new AbortController()
    api.listSdlcStages(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted && list.length > 0) setStages(sortStages(list))
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
    if (!executable || runtimeStage === null) return
    runsController.current?.abort()
    const controller = new AbortController()
    runsController.current = controller
    try {
      const value = await api.listStageRuns(projectId, runtimeStage, controller.signal)
      if (!controller.signal.aborted) setRuns({ status: 'ready', value })
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      setRuns((current) => (current.status === 'ready' ? current : { status: 'error', error }))
    }
  }, [api, projectId, runtimeStage, executable])

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

  const runIdForStage = executable ? routeRunId : null
  const poller = useStageRun(api, runIdForStage, refreshAll)
  const run = poller.run !== null && poller.run.id === runIdForStage && poller.run.projectId === projectId && poller.run.stage === routeStage ? poller.run : null
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
  const activityLog = useRunEvents(api, run?.id ?? null, runLive, onActivityEnd)
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
  const [stageSettingsOpen, setStageSettingsOpen] = useState(false)
  const stageState = sdlc?.stages.find((entry) => entry.stage === routeStage)
  const completedStages = sdlc?.stages.filter((entry) => entry.status === 'completed').length ?? 0
  const allRequired = checklist === null ? null : requiredProgress(checklist)
  const viewedProgress = viewedChecklist === null ? null : requiredProgress(viewedChecklist)
  const next = nextStageKey(stages, routeStage)
  const barItems = useMemo(
    () => (sdlc === undefined ? [] : buildStageBar(stages, sdlc.stages, currentStage, routeStage)),
    [sdlc, stages, currentStage, routeStage],
  )
  // A finished stage is viewable but never editable from here (editing earlier
  // stages, with invalidation of later work, is a later feature).
  const historical = isHistoricalStage(barItems, routeStage)
  const statusData = useStatusBarData(api, projectId, run?.status ?? 0)

  // Stage chat context, read at send time so it reflects the latest run and documents.
  const contextInputs = {
    stageLabel,
    stageStatus: stageState?.status ?? null,
    run: run === null ? null : { attempt: run.attempt, status: run.status, id: run.id },
    checklist: viewedChecklist ?? [],
    documents: run !== null ? run.documents : stageDocuments ?? [],
    history: stages.map((stage) => ({ key: stage.key, label: stage.name, state: sdlc?.stages.find((entry) => entry.stage === stage.key) })),
  }
  const contextRef = useRef(contextInputs)
  contextRef.current = contextInputs
  const getStageContext = useCallback((): string | null => buildStageContext({
    projectName: project.name,
    stageKey: routeStage,
    readOnly: historical,
    ...contextRef.current,
  }), [historical, project.name, routeStage])

  useEffect(() => {
    document.title = `${stageLabel} · ${project.name} — AI Factory Chat`
  }, [stageLabel, project.name])

  // --- Brief draft (survives navigation) ------------------------------------

  const [brief, setBriefState] = useState<string>(() => loadBrief(storage, projectId, routeStage) ?? '')
  const briefSeeded = useRef(loadBrief(storage, projectId, routeStage) !== null)
  const setBrief = useCallback((value: string) => {
    briefSeeded.current = true
    setBriefState(value)
    saveBrief(storage, projectId, value, routeStage)
  }, [storage, projectId, routeStage])
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
      const view = describeStageError(error, routeStage)
      setExecuteNotice({ runId, view })
    } finally {
      // One poller per run: restart it only if it has stopped (a still-running
      // loop picks up the new status on its next tick).
      if (!pollingRef.current) poller.resume()
      void loadRuns()
    }
  }, [api, poller.replace, poller.resume, loadRuns, routeStage])

  const attachments = useStageAttachments(api, projectId, runtimeStage ?? PLANNING, executable)

  const startRun = async (): Promise<void> => {
    if (!executable || runtimeStage === null || routeStage !== currentStage || starting || attachments.uploading) return
    setStarting(true)
    setStartError(null)
    try {
      const created = await api.createStageRun(projectId, runtimeStage, {
        brief: brief.trim(),
        ...(attachments.items.length > 0 ? { attachmentIds: attachments.items.map((entry) => entry.id) } : {}),
      })
      setRuns((current) => (current.status === 'ready'
        ? { status: 'ready', value: [created, ...current.value.filter((entry) => entry.id !== created.id)] }
        : current))
      navigate({ name: 'stage', projectId, stage: routeStage, runId: created.id })
      await execute(created.id)
    } catch (error) {
      // A stale id (404 ATTACHMENT_NOT_FOUND) is recoverable: refresh the list and let the user retry.
      if (error instanceof ApiError && error.code === 'ATTACHMENT_NOT_FOUND') void attachments.refresh()
      setStartError(describeStageError(error, routeStage))
    } finally {
      setStarting(false)
    }
  }

  // Gate answers (decision, refine, apply/accept). Each call takes as long as a
  // role run; the UI re-reads `pendingGate` from the result instead of assuming.
  const [deciding, setDeciding] = useState(false)
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const settleGateCall = async (call: () => Promise<StageRunDetail>, success?: (run: StageRunDetail) => string | null): Promise<void> => {
    if (run === null) return
    setDeciding(true)
    setDecisionError(null)
    try {
      const updated = await call()
      poller.replace(updated)
      const message = success?.(updated) ?? null
      if (message !== null) onNotify(message, 'success')
      if (isPollable(updated.status) && !pollingRef.current) poller.resume()
      refreshAll()
    } catch (error) {
      if (error instanceof ApiError && STALE_GATE_CODES.has(error.code)) {
        // The panel was out of date: show the latest run, no error toast.
        try { poller.replace(await api.getStageRun(run.id)) } catch { poller.resume() }
        refreshAll()
      } else {
        const view = describeStageError(error, routeStage)
        setDecisionError(`${view.title}. ${view.message}`)
        if (view.kind === 'awaiting-human') poller.resume()
      }
    } finally {
      setDeciding(false)
    }
  }
  const decide = (decision: HumanDecision, note: string): Promise<void> =>
    settleGateCall(
      () => api.decideStageRun(run!.id, { decision, ...(note.trim() === '' ? {} : { note: note.trim() }) }),
      () => `${DECISION_LABEL[decision]} recorded`,
    )
  const refine = (): Promise<void> =>
    settleGateCall(() => api.decideStageRun(run!.id, { refine: true }), (updated) => (updated.status === 'awaiting_human' ? 'Refinement done. Your answer is needed again.' : null))
  const decideRequirements = (input: RequirementsDecisionInput): Promise<void> =>
    settleGateCall(() => api.decideStageRun(run!.id, input), () => input.decision === 'approved' ? 'Requirements approved.' : 'Rejection recorded. Nothing was published.')

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
      const view = describeStageError(error, routeStage)
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

  const gate = advanceBlock({
    currentStage,
    viewedStage: routeStage,
    run: run ?? (latestRun?.status === 'completed' ? latestRun : null),
    checklist: checklist ?? [],
    nextStage: next,
  })
  const gateRun = run ?? latestRun

  const advanceCard = executable && gateRun !== null && gateRun.status === 'completed' && currentStage === routeStage && next !== null && recordedDecision(gateRun) !== 'no_go' ? (
    <section className="stage-card advance-card" aria-labelledby="advance-title">
      <header className="stage-card-head stage-card-head-compact">
        <div>
          <span className="eyebrow">Stage gate</span>
          <h3 id="advance-title">Advance to {stageName(stages, next)}</h3>
        </div>
      </header>
      <p className="field-hint">
        {gate === null
          ? `All required ${stageLabel} items are done. Advancing starts the next stage.`
          : gate === 'checklist-open'
            ? 'Some required checklist items are still open.'
            : routeStage === PLANNING ? 'Advancing needs a completed run with a go or conditional-go decision.' : 'Advancing needs an approved requirements run.'}
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
        status={apiProject?.status ?? project.status}
        currentStageName={projectDetail === null ? null : stageName(stages, currentStage)}
        completedStages={projectDetail === null ? null : completedStages}
        totalStages={stages.length}
        required={allRequired}
        health={health}
        onOpenSettings={onOpenSettings}
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
        <ProjectPanel project={project} apiProject={apiProject} onOpenSettings={onEditProject} {...(executable && apiProject !== null ? { onOpenStageSettings: () => setStageSettingsOpen(true) } : {})} />
        {executable && runtimeStage !== null && <StageSettingsDialog open={stageSettingsOpen} api={api} projectId={project.id} stageName={stageLabel} stage={runtimeStage} onClose={() => setStageSettingsOpen(false)} />}

        <div className="stage-center">
          {sdlc === undefined ? (
            <div className="stage-bar stage-bar-loading">{detail.status === 'loading' ? <Skeleton lines={1} /> : null}</div>
          ) : (
            <StageBar projectId={projectId} items={barItems} summary={stageBarSummary(barItems, routeStage)} />
          )}

        <main className="stage-main" aria-labelledby="stage-title">
          <header className="stage-head">
            <div className="stage-head-row">
              <span className="eyebrow">Stage {Math.max(1, stages.findIndex((stage) => stage.key === routeStage) + 1)}/{stages.length}</span>
              <h1 id="stage-title">{stageLabel}</h1>
              {routeStage === PLANNING && (
                <span
                  className="stage-head-info"
                  tabIndex={0}
                  role="img"
                  aria-label="Validate the business idea and assess Technical, Economic, Legal, Operational and Schedule feasibility."
                  title="Validate the business idea and assess Technical, Economic, Legal, Operational and Schedule feasibility."
                >
                  <InfoIcon size={14} />
                </span>
              )}
              <div className="stage-head-meta">
                {stageState !== undefined && <StageStatusChip status={stageState.status} />}
                {viewedProgress !== null && viewedProgress.total > 0 && <ProgressMeter done={viewedProgress.done} total={viewedProgress.total} label="Required items done" />}
                {run !== null && <RunStatusChip status={run.status} stage={run.stage} />}
              </div>
            </div>
          </header>

          <div className="stage-body">
            {detail.status === 'loading' ? (
              <>
                <Skeleton lines={3} className="stage-card" />
                <Skeleton lines={5} className="stage-card" />
              </>
            ) : detailErrorView !== null && projectDetail === null ? (
              <StageNotice error={detailErrorView} {...(detailErrorView.kind === 'unauthorized' ? {} : { onRetry: refreshAll })} />
            ) : noRuntime ? (
              <StageNotice
                tone="info"
                error={{ title: 'Stage runtime not available', message: 'This Chat API doesn’t expose SDLC stages. Update apps/chat-cli to use stage runs.' }}
              />
            ) : !knownStage ? (
              <StageNotice error={{ title: 'Stage not found', message: `“${routeStage}” isn’t an SDLC stage.` }}>
                <a className="text-button" href={routeHref({ name: 'stage', projectId, stage: currentStage, runId: null })}>Go to the current stage</a>
              </StageNotice>
            ) : !executable || (!historical && routeStage !== currentStage) ? (
              <ReadOnlyStage stageName={stageLabel} isCurrent={routeStage === currentStage} />
            ) : (
              <ExecutableWorkspace
                api={api}
                projectId={projectId}
                stage={routeStage}
                stageLabel={stageLabel}
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
                attachments={attachments}
                onRefine={() => void refine()}
                onDecideRequirements={(input) => void decideRequirements(input)}
                advanceCard={historical ? null : advanceCard}
                readOnly={historical}
                onRetryRuns={() => void loadRuns()}
                onNotify={onNotify}
              />
            )}
            {knownStage && projectDetail !== null && !noRuntime && (
              <ArtifactsCard api={api} stage={routeStage} documents={run !== null ? run.documents : stageDocuments} onNotify={onNotify} />
            )}
          </div>

          {knownStage && (
            <StageChatDock
              key={routeStage}
              api={api}
              storage={storage}
              project={project}
              stageKey={routeStage}
              stageLabel={stageLabel}
              sessions={sessions}
              health={health.state}
              getContext={getStageContext}
              onSessionStarted={onSessionStarted}
              onRefreshSessions={onRefreshSessions}
              onRefreshHealth={health.refresh}
              onOpenSettings={onOpenSettings}
              onNotify={onNotify}
            />
          )}
        </main>
        </div>

        {projectDetail === null ? (
          <aside className="context-panel">{detail.status === 'loading' ? <Skeleton lines={8} /> : null}</aside>
        ) : (
          <ContextPanel
            api={api}
            checklist={viewedChecklist}
            documents={run !== null ? run.documents : stageDocuments}
            onNotify={onNotify}
          />
        )}
      </div>

      <StatusBar
        data={statusData}
        telemetry={run !== null ? activityLog.telemetry : null}
        stale={activityLog.connection === 'error' || activityLog.connection === 'reconnecting'}
        runText={run === null ? null : `Attempt ${run.attempt} · ${runStatusLabel(run.status, routeStage)}`}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------

function ProjectStageHeader({
  project,
  status,
  currentStageName,
  completedStages,
  totalStages,
  required,
  health,
  onOpenSettings,
}: {
  project: Project
  status: string | undefined
  currentStageName: string | null
  completedStages: number | null
  totalStages: number
  required: { done: number; total: number } | null
  health: ApiHealthController
  onOpenSettings: () => void
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
        <button type="button" className="health-pill" data-status={health.state.status} onClick={onOpenSettings} title={health.state.error ?? 'Connection settings'}>
          <span className="status-dot" aria-hidden="true" />
          {healthLabel(health.state)}
        </button>
        <button type="button" className="icon-button" aria-label="Settings" title="Settings" onClick={onOpenSettings}>
          <SettingsIcon size={16} />
        </button>
      </div>
    </header>
  )
}

function ReadOnlyNotice() {
  return (
    <div className="stage-notice" data-tone="info" role="note">
      <InfoIcon size={16} />
      <div className="stage-notice-body">
        <strong>Completed stage — read-only</strong>
        <p>You can review the run, reviews and artifacts. Changing a finished stage isn’t available yet.</p>
      </div>
    </div>
  )
}

function ReadOnlyStage({ stageName: name, isCurrent }: { stageName: string; isCurrent: boolean }) {
  return (
    <div className="stage-card stage-readonly">
      <span className="chip run-chip" data-status="cancelled"><span className="chip-glyph" aria-hidden="true" />Read-only</span>
      <h3>Runtime not implemented yet</h3>
      <p>
        {name} can’t be executed from the UI yet. {isCurrent
          ? 'This is the project’s current stage; its checklist is on the right.'
          : 'Its checklist is shown on the right.'}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface ExecutableWorkspaceProps {
  api: ChatApi
  projectId: string
  stage: string
  stageLabel: string
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
  attachments: StageAttachments
  onDecide: (decision: HumanDecision, note: string) => void
  onRefine: () => void
  onDecideRequirements: (input: RequirementsDecisionInput) => void
  advanceCard: ReactNode
  /** Finished stage: show progress and artifacts, change nothing. */
  readOnly: boolean
  onRetryRuns: () => void
  onNotify: (message: string, tone: 'success' | 'error' | 'info') => void
}

function ExecutableWorkspace(props: ExecutableWorkspaceProps) {
  const { run, runId, poller, runs, activity, stage, stageLabel } = props
  const runList = runs.status === 'ready' ? runs.value : null
  const runActive = run !== null && (isPollable(run.status) || run.status === 'awaiting_human')
  // Memoized per event batch; also feeds the pipeline step badges.
  const roleTotals = useMemo(() => roleSummaries(buildTimeline(activity.log.events, runActive)), [activity.log.events, runActive])

  if (runId === null) {
    return (
      <>
        {props.advanceCard}
        {props.readOnly ? <ReadOnlyNotice /> : <BriefCard {...props} title={runList !== null && runList.length > 0 ? 'Start a new attempt' : stage === 'requirements' ? 'Requirements brief' : 'Business brief'} />}
        <RunHistory stage={stage} projectId={props.projectId} runs={runs} activeRunId={null} onRetry={props.onRetryRuns} />
      </>
    )
  }

  const loadError = poller.error === null ? null : describeStageError(poller.error, stage)
  if (run === null) {
    return poller.loading || (loadError === null && poller.run === null) ? (
      <>
        <Skeleton lines={2} className="stage-card" />
        <Skeleton lines={4} className="stage-card" />
      </>
    ) : (
      <StageNotice error={loadError ?? { title: 'Run not found here', message: 'This run does not belong to the selected project and stage.' }} {...(loadError === null || loadError.kind === 'not-found' || loadError.kind === 'unauthorized' ? {} : { onRetry: poller.resume })}>
        <a className="text-button" href={routeHref({ name: 'stage', projectId: props.projectId, stage, runId: null })}>Back to {stageLabel}</a>
      </StageNotice>
    )
  }

  const failure = failureMessage(run)
  const cycleLimit = isCycleLimit(run)
  const role = failedRole(run, stage)
  const stopped = run.status === 'failed' || run.status === 'cancelled'
  const decision = recordedDecision(run)
  const artifact = stageArtifact(run.documents, stage)
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
            <RunStatusChip status={run.status} stage={run.stage} />
          </div>
        </header>
        <p className="run-times">
          <TimeAgo iso={run.createdAt} prefix="Created" />
          {run.startedAt !== null && <> · <TimeAgo iso={run.startedAt} prefix="started" /></>}
          {run.completedAt !== null && <> · <TimeAgo iso={run.completedAt} prefix="finished" /></>}
          {poller.polling && <span className="run-polling"> · updating…</span>}
        </p>
        <p className="sr-only" aria-live="polite">Run status: {runStatusLabel(run.status, stage)}</p>
        <CurrentActivityLine events={activity.log.events} connection={activity.log.connection} expanded={activity.open} onOpen={() => openActivity(null)} />

        {run.status === 'pending' && !props.executeRequested && !props.readOnly && (
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
        stage={stage}
        run={run}
        lastSeenStep={poller.lastSeenStep}
        activity={{ summaries: roleTotals, onOpen: (role) => openActivity(role), openRole: activity.open ? (activity.filters.role === 'all' || activity.filters.role === 'run' ? null : activity.filters.role) : null }}
      />

      {props.readOnly && <ReadOnlyNotice />}

      {run.status === 'awaiting_human' && !props.readOnly && (() => {
        const gate = gateOf(run)
        if (stage === 'requirements') {
          return gate?.kind === 'final'
            ? <RequirementsFinalGatePanel key={`${run.id}:${gate.waitingSince}`} gate={gate} draftMarkdown={run.draftMarkdown} busy={props.deciding} error={props.decisionError} onDecide={props.onDecideRequirements} onRefine={props.onRefine} rejectionRecorded={requirementsRejectionRecorded(run)} />
            : <StageNotice error={{ title: 'Approval details unavailable', message: 'Refresh the run to load the requirements gate before deciding.' }} onRetry={poller.resume} />
        }
        if (gate?.kind === 'final') {
          return <FinalGatePanel gate={gate} draftMarkdown={run.draftMarkdown} busy={props.deciding} error={props.decisionError} onComplete={props.onDecide} onRefine={props.onRefine} />
        }
        // Older API without `pendingGate`: the plain decision form.
        return <DecisionPanel stage={stage} busy={props.deciding} error={props.decisionError} onDecide={props.onDecide} />
      })()}

      {props.advanceCard}

      <ReviewsCard stage={stage} reviews={run.reviews} cycleLimit={cycleLimit} />

      {stopped && <PartialOutputCard stage={stage} run={run} />}

      {artifact !== undefined ? (
        <StageDocument stage={stage} api={props.api} document={artifact} runId={run.id} exportFailed={exportFailure(activity.log.events)} onNotify={props.onNotify} />
      ) : (
        <section className="stage-card">
          <header className="stage-card-head stage-card-head-compact"><h3>{stageArtifactTitle(stage)}</h3></header>
          <p className="section-empty-inline">
            {run.status === 'awaiting_human'
              ? 'Nothing is produced before you approve. The document and PDF appear after you complete the stage; the draft is previewed in the gate above.'
              : isPollable(run.status)
              ? 'The document appears here after human approval.'
              : stopped && (run.analysisMarkdown || run.draftMarkdown)
                ? 'No approved document was stored for this run. See Partial output above for the saved draft.'
                : 'No document was stored for this run.'}
          </p>
        </section>
      )}

      {run.summaryMarkdown !== null && run.summaryMarkdown.trim() !== '' && failure === null && (
        <details className="stage-card run-summary">
          <summary>Run summary</summary>
          <Markdown>{run.summaryMarkdown}</Markdown>
        </details>
      )}

      {!props.readOnly && (
        <details className="stage-card brief-disclosure" open={offerRetry || undefined}>
          <summary>Start a new attempt</summary>
          <BriefCard {...props} title={null} />
        </details>
      )}

      <RunHistory stage={stage} projectId={props.projectId} runs={runs} activeRunId={run.id} onRetry={props.onRetryRuns} />

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
  attachments,
  stage,
  title,
}: ExecutableWorkspaceProps & { title: string | null }) {
  const id = useId()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const requirements = stage === 'requirements'
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
        <label className="field-label" htmlFor={id}>{requirements ? 'Requirements brief' : 'Business idea and stakeholder goals'}</label>
        <p className="field-hint" id={`${id}-help`}>
          {requirements ? 'Describe the actors, workflows, scope, and constraints that the specification should cover.' : 'Describe the problem, target users, business idea, stakeholder goals, success measures and known constraints. The analyzer will turn this into a TELOS feasibility report.'}
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
              ? <span className="field-warning">An empty brief can be used when other inputs satisfy stage prerequisites.</span>
              : <span className="field-hint">Saved in this browser until you start a run.</span>}
          <span className="field-hint" data-over={over || undefined}>{brief.length.toLocaleString()} / {MAX_BRIEF_CHARS.toLocaleString()}</span>
        </div>
      </div>
      <AttachmentsField attachments={attachments} disabled={disabled} runQueued={startDisabled} />
      {startError !== null && <StageNotice error={startError} />}
      <div className="stage-card-foot">
        {startDisabled && <span className="field-hint">A run is executing. Wait for it to finish.</span>}
        <button type="submit" className="button button-primary" disabled={disabled || over || attachments.uploading}>
          {starting ? 'Starting…' : requirements ? 'Start requirements run' : 'Start planning run'}
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

function RunHistory({ stage, projectId, runs, activeRunId, onRetry }: { stage: string; projectId: string; runs: Loadable<StageRun[]>; activeRunId: string | null; onRetry: () => void }) {
  return (
    <section className="stage-card run-history" aria-labelledby="run-history-title">
      <header className="stage-card-head stage-card-head-compact"><h3 id="run-history-title">Run history</h3></header>
      {runs.status === 'loading' ? <Skeleton lines={2} /> : runs.status === 'error' ? (
        <StageNotice error={describeStageError(runs.error, stage)} onRetry={onRetry} />
      ) : runs.value.length === 0 ? (
        <p className="section-empty-inline">No runs yet.</p>
      ) : (
        <ol className="run-history-list">
          {runs.value.map((entry) => (
            <li key={entry.id}>
              <a
                className="run-history-row"
                href={routeHref({ name: 'stage', projectId, stage, runId: entry.id })}
                aria-current={entry.id === activeRunId ? 'page' : undefined}
              >
                <span className="run-history-attempt">Attempt {entry.attempt}</span>
                <RunStatusChip status={entry.status} stage={stage} />
                <span className="run-history-time"><TimeAgo iso={entry.updatedAt} prefix="updated" /></span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
