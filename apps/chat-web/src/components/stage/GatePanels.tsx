import { useId, useState } from 'react'
import type { HumanDecision, PendingGate, RequirementsCoverageFinding, RequirementsCoverageReport, RequirementsDecisionInput } from '../../api/types.ts'
import { cycleLabel, MAX_COVERAGE_WAIVER_CHARS, requirementsDecisionInput } from '../../data/gates.ts'
import { DECISION_LABEL } from '../../data/stages.ts'
import { pluralize } from '../../lib/format.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { Markdown } from '../Markdown.tsx'
import { DECISION_HELP } from './RunPanels.tsx'

const REVIEW_LABEL: Record<string, string> = { approved: 'approved', needs_revision: 'changes requested', rejected: 'rejected' }

function GateHead({ eyebrow, title, gate }: { eyebrow: string; title: string; gate: PendingGate }) {
  const cycle = cycleLabel(gate)
  return (
    <header className="stage-card-head stage-card-head-compact">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h3>{title}</h3>
      </div>
      {cycle !== '' && <span className="chip gate-cycle">{cycle}</span>}
    </header>
  )
}

/** Requirements approval is separate from Planning's feasibility decision. */
export function RequirementsFinalGatePanel({
  gate,
  draftMarkdown,
  busy,
  error,
  rejectionRecorded = false,
  onDecide,
  onRefine,
}: {
  gate: PendingGate
  draftMarkdown: string | null | undefined
  busy: boolean
  error: string | null
  rejectionRecorded?: boolean
  onDecide: (input: RequirementsDecisionInput) => void
  onRefine: () => void
}) {
  const [note, setNote] = useState('')
  const [waiverReason, setWaiverReason] = useState('')
  const [confirm, setConfirm] = useState<'reject' | 'waive' | null>(null)
  const noteId = useId()
  const waiverId = useId()
  const reviewLabel = gate.reviewDecision === null ? null : (REVIEW_LABEL[gate.reviewDecision] ?? gate.reviewDecision)
  const blockers = gate.coverage?.findings.filter((finding) => finding.severity === 'blocking') ?? []
  const approve = requirementsDecisionInput('approve', gate.coverage, note)
  const waive = requirementsDecisionInput('waive', gate.coverage, note, waiverReason)

  return (
    <section className="stage-card decision-card gate-card" data-gate="final" aria-label="Requirements approval" aria-busy={busy || undefined}>
      <GateHead eyebrow="Final gate" title="Requirements approval" gate={gate} />
      <p className="field-hint">Approval publishes the requirements document and produces its PDF. Rejecting keeps the draft at this gate and publishes nothing.</p>
      {rejectionRecorded && <p role="status"><strong>Rejection recorded.</strong> The draft is still open for refinement or a new decision.</p>}
      {reviewLabel !== null && <p className="field-hint">Model review: {reviewLabel}{gate.findings.length > 0 ? ` · ${pluralize(gate.findings.length, 'finding')}` : ''}</p>}
      {gate.outcome !== null && <GateOutcomeLine outcome={gate.outcome} requirements />}
      {typeof draftMarkdown === 'string' && draftMarkdown.trim() !== '' && (
        <details className="gate-draft">
          <summary>Preview draft</summary>
          <div className="gate-draft-body"><Markdown>{draftMarkdown}</Markdown></div>
        </details>
      )}

      <RequirementsCoverage coverage={gate.coverage} />
      <div className="field">
        <label className="field-label" htmlFor={noteId}>Decision note <span className="field-optional">optional</span></label>
        <textarea id={noteId} className="text-input text-area" rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
      </div>
      {blockers.length > 0 && (
        <details className="gate-draft">
          <summary>Request a coverage waiver</summary>
          <div className="gate-draft-body">
            <p id={`${waiverId}-help`} className="field-hint">The reason and the blocking findings will be recorded in the audit trail. The waiver applies only to approval of this draft.</p>
            <div className="field">
              <label className="field-label" htmlFor={waiverId}>Coverage waiver reason</label>
              <textarea
                id={waiverId}
                className="text-input text-area"
                rows={3}
                maxLength={MAX_COVERAGE_WAIVER_CHARS}
                value={waiverReason}
                disabled={busy}
                aria-describedby={`${waiverId}-help ${waiverId}-count`}
                onChange={(event) => setWaiverReason(event.target.value)}
              />
              <p id={`${waiverId}-count`} className="field-hint">{waiverReason.length} / {MAX_COVERAGE_WAIVER_CHARS} characters. A nonblank reason is required.</p>
            </div>
            <button type="button" className="button button-danger" disabled={busy || waive === null} onClick={() => setConfirm('waive')}>
              Approve with coverage waiver
            </button>
          </div>
        </details>
      )}
      {error !== null && <p className="field-error" role="alert">{error}</p>}
      <div className="stage-card-foot gate-actions">
        <button type="button" className="button button-primary" disabled={busy || approve === null} onClick={() => { if (approve !== null) onDecide(approve) }}>
          {busy ? 'Working…' : 'Approve requirements'}
        </button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={onRefine}>Refine further</button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={() => setConfirm('reject')}>Reject draft</button>
      </div>
      <p className="field-hint gate-hint">Refining runs another review and revises the draft if needed, then returns here without publishing.</p>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'waive' ? 'Approve despite coverage blockers?' : 'Reject this requirements draft?'}
        description={confirm === 'waive'
          ? `Approval will publish this draft despite ${pluralize(blockers.length, 'coverage blocker')}. The waiver reason and waived findings will be audited.`
          : 'Your rejection and any note will be recorded. The draft remains at the final gate with nothing published.'}
        confirmLabel={confirm === 'waive' ? 'Approve with waiver' : 'Record rejection'}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const input = confirm === 'waive' ? waive : requirementsDecisionInput('reject', gate.coverage, note)
          setConfirm(null)
          if (input !== null) onDecide(input)
        }}
      />
    </section>
  )
}

function CoverageFindings({ title, findings }: { title: string; findings: RequirementsCoverageFinding[] }) {
  if (findings.length === 0) return null
  return (
    <>
      <h5 className="gate-subtitle">{title}</h5>
      <ul className="finding-list gate-findings">
        {findings.map((finding, index) => (
          <li key={index} className="finding" data-severity={finding.severity === 'blocking' ? 'blocker' : 'minor'}>
            <div className="finding-head">
              <code className="finding-id">{finding.code}</code>
              {finding.requirementId !== undefined && <span className="finding-section">{finding.requirementId}</span>}
            </div>
            <div className="finding-body"><p>{finding.message}</p></div>
          </li>
        ))}
      </ul>
    </>
  )
}

function RequirementsCoverage({ coverage }: { coverage: RequirementsCoverageReport | null }) {
  if (coverage === null) return <p className="field-hint">No deterministic coverage report is available for this draft. The server will check coverage before approving.</p>
  const { counts, findings } = coverage
  const blockers = findings.filter((finding) => finding.severity === 'blocking')
  const advisories = findings.filter((finding) => finding.severity === 'advisory')
  return (
    <section aria-label="Deterministic coverage">
      <h4 className="gate-subtitle">Deterministic coverage</h4>
      <p className="field-hint">
        Acceptance criteria: {counts.withAcceptanceCriteria}/{counts.totalRequirements} · Sources: {counts.withSource}/{counts.totalRequirements} · Goals: {counts.withGoal}/{counts.totalRequirements}
      </p>
      {(counts.priorities !== undefined || counts.businessRules !== undefined) && (
        <p className="field-hint">
          {counts.priorities !== undefined && <>Priorities: {counts.priorities.must} must · {counts.priorities.should} should · {counts.priorities.could} could · {counts.priorities.wont} won’t</>}
          {counts.priorities !== undefined && counts.businessRules !== undefined && ' · '}
          {counts.businessRules !== undefined && <>Business rules: {counts.businessRules}</>}
        </p>
      )}
      {blockers.length > 0
        ? <p className="field-error">Ordinary approval is blocked. Refine the draft or explicitly approve it with an audited waiver.</p>
        : <p className="field-hint">No blocking coverage findings.</p>}
      <CoverageFindings title={`Blocking (${blockers.length})`} findings={blockers} />
      <CoverageFindings title={`Advisory (${advisories.length}) — does not block approval`} findings={advisories} />
    </section>
  )
}

/** Final gate: record the decision to complete the stage (and produce the PDF), or refine once more. */
export function FinalGatePanel({
  gate,
  draftMarkdown,
  busy,
  error,
  onComplete,
  onRefine,
}: {
  gate: PendingGate
  draftMarkdown: string | null | undefined
  busy: boolean
  error: string | null
  onComplete: (decision: HumanDecision, note: string) => void
  onRefine: () => void
}) {
  const [choice, setChoice] = useState<HumanDecision | null>(null)
  const [note, setNote] = useState('')
  const [confirmNoGo, setConfirmNoGo] = useState(false)
  const noteId = useId()
  const groupId = useId()
  const reviewLabel = gate.reviewDecision === null ? null : (REVIEW_LABEL[gate.reviewDecision] ?? gate.reviewDecision)
  const draft = typeof draftMarkdown === 'string' && draftMarkdown.trim() !== '' ? draftMarkdown : null

  const submit = (): void => {
    if (choice === null || busy) return
    if (choice === 'no_go') setConfirmNoGo(true)
    else onComplete(choice, note)
  }

  return (
    <section className="stage-card decision-card gate-card" data-gate="final" aria-labelledby={groupId} aria-busy={busy || undefined}>
      <GateHead eyebrow="Final gate" title={reviewLabel === null ? 'Draft ready' : `Draft ready — review: ${reviewLabel}`} gate={gate} />
      <p className="field-hint">
        {gate.findings.length > 0 ? `${pluralize(gate.findings.length, 'finding')} from the last review. ` : ''}
        No document or PDF exists yet; they are produced when you complete the stage.
      </p>

      {gate.outcome !== null && <GateOutcomeLine outcome={gate.outcome} />}

      {draft !== null && (
        <details className="gate-draft">
          <summary>Preview draft</summary>
          <div className="gate-draft-body"><Markdown>{draft}</Markdown></div>
        </details>
      )}

      <h4 className="gate-subtitle" id={groupId}>Decision</h4>
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
      <div className="stage-card-foot gate-actions">
        <button type="button" className={choice === 'no_go' ? 'button button-danger' : 'button button-primary'} disabled={choice === null || busy} onClick={submit}>
          {busy ? 'Working…' : choice === null ? 'Choose a decision' : 'Complete stage and produce PDF'}
        </button>
        <button type="button" className="button button-secondary" disabled={busy} onClick={onRefine}>
          Refine further
        </button>
      </div>
      <p className="field-hint gate-hint">Refine further: one more review and revision, then you will be asked again.</p>
      <ConfirmDialog
        open={confirmNoGo}
        title="Record a no-go decision?"
        description="The run completes with a no-go and the project stays in Planning. You can start a new attempt later."
        confirmLabel="Record no-go"
        busy={busy}
        onClose={() => setConfirmNoGo(false)}
        onConfirm={() => {
          setConfirmNoGo(false)
          onComplete('no_go', note)
        }}
      />
    </section>
  )
}

/** Why the run stopped revising: the criteria were met, or the iteration budget ran out. */
function GateOutcomeLine({ outcome, requirements = false }: { outcome: NonNullable<PendingGate['outcome']>; requirements?: boolean }) {
  const { counts, criteria, rating } = outcome
  const found = [
    rating === null ? null : `rating ${rating}`,
    counts === null ? null : `${pluralize(counts.blockers, 'blocker')}, ${pluralize(counts.major, 'major issue')}`,
  ].filter((part): part is string => part !== null).join(' · ')
  const needed = criteria === null ? null : `${criteria.minRating}+ rating, ≤ ${criteria.maxBlockers} blockers, ≤ ${criteria.maxMajor} major`
  return (
    <p className="gate-outcome" data-accepted={outcome.accepted} role="status">
      <strong>{requirements
        ? (outcome.accepted ? 'Review and coverage checks passed' : 'Review or coverage checks did not pass')
        : (outcome.accepted ? 'Review criteria met' : 'Review criteria not met')}</strong>
      {found !== '' && <> — {found}</>}
      {needed !== null && <span className="field-hint"> (required: {needed})</span>}
      {!outcome.accepted && <span className="field-hint">{requirements ? ' The draft is awaiting your decision.' : ' The iteration budget is spent, so your approval is needed.'}</span>}
    </p>
  )
}
