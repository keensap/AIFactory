import { useId, useState } from 'react'
import type { Finding, HumanDecision, StageReview, StageRunDetail } from '../../api/types.ts'
import {
  DECISION_LABEL,
  findingText,
  partialOutputs,
  pipelineSteps,
  revisionCount,
  severityCounts,
  sortReviews,
  type PipelineStepKey,
} from '../../data/stages.ts'
import { pluralize } from '../../lib/format.ts'
import { roleSummaries, shortDuration } from '../../data/activity.ts'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '../Icons.tsx'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { Markdown } from '../Markdown.tsx'
import { TimeAgo } from './StageBits.tsx'
import { saveBlob } from './TelosDocument.tsx'

// ---------------------------------------------------------------------------
// Pipeline

export interface PipelineActivity {
  /** Per-role totals from the event log (real role_end durations only). */
  summaries: ReturnType<typeof roleSummaries>
  /** Open the Activity drawer filtered to this role. */
  onOpen: (role: PipelineStepKey) => void
  openRole: PipelineStepKey | null
}

export function PipelineCard({ run, lastSeenStep, activity, stage = run.stage }: { run: StageRunDetail; lastSeenStep: PipelineStepKey | null; activity?: PipelineActivity; stage?: string }) {
  const steps = pipelineSteps(run, lastSeenStep, stage)
  const stateText = { waiting: 'waiting', active: 'in progress', done: 'complete', failed: 'failed' } as const
  return (
    <section className="stage-card pipeline-card" aria-label="Pipeline">
      <header className="stage-card-head stage-card-head-compact">
        <h3>Pipeline</h3>
        {run.status === 'pending' && <span className="field-hint">Queued — waiting for the analyzer to start.</span>}
        {activity !== undefined && run.status !== 'pending' && <span className="field-hint">Select a step to see what it’s doing.</span>}
      </header>
      <ol className="pipeline">
        {steps.map((step, index) => {
          const summary = activity?.summaries[step.key]
          const meta: string[] = []
          if (summary !== undefined) {
            if (summary.passes > 1) meta.push(`${summary.passes} passes`)
            if (summary.durationMs > 0) meta.push(shortDuration(summary.durationMs))
            meta.push(pluralize(summary.events, 'event'))
          }
          const content = (
            <>
              <span className="pipeline-dot" aria-hidden="true">
                {step.state === 'done' ? <CheckIcon size={12} strokeWidth={2.8} /> : step.state === 'failed' ? '!' : index + 1}
              </span>
              <span className="pipeline-label">{step.label}</span>
              <span className="pipeline-state">
                {stateText[step.state]}
                {meta.length > 0 && <span className="pipeline-meta"> · {meta.join(' · ')}</span>}
              </span>
            </>
          )
          return (
            <li key={step.key} className="pipeline-step" data-state={step.state} data-role={step.key}>
              {activity === undefined ? content : (
                <button
                  type="button"
                  className="pipeline-button"
                  aria-expanded={activity.openRole === step.key}
                  aria-controls="run-activity"
                  aria-label={`${step.label}: ${stateText[step.state]}. Show ${step.label} activity`}
                  onClick={() => activity.onOpen(step.key)}
                >
                  {content}
                  <ChevronRightIcon size={13} className="pipeline-chevron" />
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Reviews

const DECISION_TEXT: Record<string, string> = {
  approved: 'Approved',
  needs_revision: 'Needs revision',
  rejected: 'Rejected',
}

export function ReviewsCard({ reviews, cycleLimit, stage = 'planning' }: { reviews: StageReview[]; cycleLimit: boolean; stage?: string }) {
  const ordered = sortReviews(reviews)
  const revisions = revisionCount(reviews)
  return (
    <section className="stage-card reviews-card" aria-labelledby="reviews-title">
      <header className="stage-card-head stage-card-head-compact">
        <h3 id="reviews-title">Reviews</h3>
        <span className="field-hint">
          {pluralize(ordered.length, 'review')} · {pluralize(revisions, 'revision')} requested
        </span>
        {cycleLimit && <span className="chip run-chip" data-status="failed"><span className="chip-glyph" aria-hidden="true" />Cycle limit reached</span>}
      </header>
      {ordered.length === 0 ? (
        <p className="section-empty-inline">
          {stage === 'planning'
            ? 'No reviews yet. The reviewer runs after the TELOS author drafts the report.'
            : 'No reviews yet. The reviewer runs after the author finishes the first draft.'}
        </p>
      ) : (
        <ol className="review-list">
          {ordered.map((review, index) => <ReviewItem key={review.id} review={review} index={index + 1} />)}
        </ol>
      )}
    </section>
  )
}

function ReviewItem({ review, index }: { review: StageReview; index: number }) {
  const [open, setOpen] = useState(review.decision !== 'approved')
  const counts = severityCounts(review.findings)
  const bodyId = useId()
  return (
    <li className="review-item" data-decision={review.decision}>
      <button
        type="button"
        className="review-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        <span className="review-title">Review {index}</span>
        <span className="chip review-chip" data-decision={review.decision}>
          <span className="chip-glyph" aria-hidden="true" />
          {DECISION_TEXT[review.decision] ?? review.decision}
        </span>
        <span className="severity-counts">
          <span data-severity="blocker">{counts.blocker} blocker</span>
          <span data-severity="major">{counts.major} major</span>
          <span data-severity="minor">{counts.minor} minor</span>
          {counts.other > 0 && <span>{counts.other} other</span>}
        </span>
        <span className="review-time"><TimeAgo iso={review.createdAt} /></span>
      </button>
      <div id={bodyId} hidden={!open}>
        {review.findings.length === 0 ? (
          <p className="section-empty-inline">No findings.</p>
        ) : (
          <ul className="finding-list">
            {review.findings.map((finding, findingIndex) => (
              <FindingItem key={`${findingText(finding.id)}-${findingIndex}`} finding={finding} />
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

const LONG_FINDING = 320

/** Reviewer output is data: rendered as plain text, long text collapses. */
export function FindingItem({ finding }: { finding: Finding }) {
  const text = findingText(finding.finding)
  const change = findingText(finding.required_change)
  const long = text.length + change.length > LONG_FINDING
  const [expanded, setExpanded] = useState(false)
  const severity = findingText(finding.severity).toLowerCase() || 'unrated'
  return (
    <li className="finding" data-severity={severity}>
      <div className="finding-head">
        <span className="finding-severity" data-severity={severity}>{severity}</span>
        {finding.id !== undefined && <code className="finding-id">{findingText(finding.id)}</code>}
        {finding.section !== undefined && <span className="finding-section">{findingText(finding.section)}</span>}
      </div>
      <div className="finding-body" data-collapsed={(long && !expanded) || undefined}>
        {text !== '' && <p>{text}</p>}
        {change !== '' && (
          <p className="finding-change"><strong>Required change:</strong> {change}</p>
        )}
      </div>
      {long && (
        <button type="button" className="text-button finding-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Decision

export const DECISION_HELP: Record<HumanDecision, string> = {
  go: 'Feasible as described. Proceed to Requirements.',
  conditional_go: 'Proceed, subject to the conditions in your note.',
  no_go: 'Not feasible now. The stage stays in Planning.',
}

export function DecisionPanel({
  busy,
  error,
  onDecide,
  stage = 'planning',
}: {
  busy: boolean
  error: string | null
  onDecide: (decision: HumanDecision, note: string) => void
  stage?: string
}) {
  const [choice, setChoice] = useState<HumanDecision | null>(null)
  const [note, setNote] = useState('')
  const [confirmNoGo, setConfirmNoGo] = useState(false)
  const noteId = useId()
  const groupId = useId()

  // The modern approval gate uses `approved`; older runs without a pending
  // gate can submit its compatible `go` value through the legacy callback.
  if (stage !== 'planning') {
    return (
      <section className="stage-card decision-card" aria-labelledby={groupId}>
        <header className="stage-card-head stage-card-head-compact">
          <div>
            <span className="eyebrow">Human gate</span>
            <h3 id={groupId}>Approve the stage output</h3>
          </div>
        </header>
        <p className="field-hint">The reviewer approved the draft. Approve it to complete the stage.</p>
        <div className="field">
          <label className="field-label" htmlFor={noteId}>Note <span className="field-optional">optional</span></label>
          <textarea id={noteId} className="text-input text-area" rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
        </div>
        {error !== null && <p className="field-error" role="alert">{error}</p>}
        <div className="stage-card-foot">
          <button type="button" className="button button-primary" disabled={busy} onClick={() => onDecide('go', note)}>
            {busy ? 'Recording…' : 'Approve'}
          </button>
        </div>
      </section>
    )
  }

  const submit = (): void => {
    if (choice === null || busy) return
    if (choice === 'no_go') setConfirmNoGo(true)
    else onDecide(choice, note)
  }

  return (
    <section className="stage-card decision-card" aria-labelledby={groupId}>
      <header className="stage-card-head stage-card-head-compact">
        <div>
          <span className="eyebrow">Human gate</span>
          <h3 id={groupId}>Record the feasibility decision</h3>
        </div>
      </header>
      <p className="field-hint">The reviewer approved the TELOS report. Read it, then decide.</p>
      <div className="decision-choices" role="radiogroup" aria-labelledby={groupId}>
        {(['go', 'conditional_go', 'no_go'] as const).map((decision) => (
          <button
            key={decision}
            type="button"
            role="radio"
            aria-checked={choice === decision}
            className="decision-choice"
            data-decision={decision}
            disabled={busy}
            onClick={() => setChoice(decision)}
          >
            <span className="decision-choice-title">{DECISION_LABEL[decision]}</span>
            <span className="decision-choice-help">{DECISION_HELP[decision]}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <label className="field-label" htmlFor={noteId}>
          Note {choice === 'conditional_go' ? <span className="field-optional">list the conditions</span> : <span className="field-optional">optional</span>}
        </label>
        <textarea
          id={noteId}
          className="text-input text-area"
          rows={3}
          value={note}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Approved by sponsor; conditions, owners, dates…"
        />
      </div>
      {error !== null && <p className="field-error" role="alert">{error}</p>}
      <div className="stage-card-foot">
        <button type="button" className={choice === 'no_go' ? 'button button-danger' : 'button button-primary'} disabled={choice === null || busy} onClick={submit}>
          {busy ? 'Recording…' : choice === null ? 'Choose a decision' : `Record ${DECISION_LABEL[choice].toLowerCase()}`}
        </button>
      </div>
      <ConfirmDialog
        open={confirmNoGo}
        title="Record a no-go decision?"
        description="The run completes with a no-go and the project stays in Planning. You can start a new attempt later."
        confirmLabel="Record no-go"
        busy={busy}
        onClose={() => setConfirmNoGo(false)}
        onConfirm={() => {
          setConfirmNoGo(false)
          onDecide('no_go', note)
        }}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Partial output of a failed run

/**
 * Analysis and latest draft the API saved before a run failed, read-only so the
 * work isn't lost. Not reviewed or approved; Markdown renders without raw HTML.
 */
export function PartialOutputCard({ run, stage = 'planning' }: { run: Pick<StageRunDetail, 'id' | 'attempt' | 'analysisMarkdown' | 'draftMarkdown'>; stage?: string }) {
  const outputs = partialOutputs(run, stage)
  if (outputs.length === 0) return null
  return (
    <section className="stage-card partial-output" aria-labelledby={`partial-${run.id}`}>
      <header className="stage-card-head stage-card-head-compact">
        <div>
          <span className="eyebrow">Saved before the failure</span>
          <h3 id={`partial-${run.id}`}>Partial output</h3>
        </div>
        <span className="chip partial-chip">Not approved</span>
      </header>
      <p className="field-hint">
        Read-only. This wasn’t approved by the reviewer and isn’t stored as a project document. Download it if you want to reuse it in the next attempt’s brief.
      </p>
      {outputs.map((output, index) => (
        <details key={output.key} className="partial-output-item" open={index === outputs.length - 1 || undefined}>
          <summary>
            <span>{output.title}</span>
            <span className="partial-output-meta">{pluralize(output.markdown.split(/\s+/).filter(Boolean).length, 'word')}</span>
          </summary>
          <div className="partial-output-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => saveBlob(new Blob([output.markdown], { type: 'text/markdown' }), `${stage}-${output.key}-attempt-${run.attempt}.md`)}
            >
              Download .md
            </button>
          </div>
          <div className="partial-output-body">
            <Markdown>{output.markdown}</Markdown>
          </div>
        </details>
      ))}
    </section>
  )
}
