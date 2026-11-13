import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { ChecklistItem, SdlcStage, StageState } from '../../api/types.ts'
import { requiredProgress, stageChecklist } from '../../data/stages.ts'
import { routeHref } from '../../lib/router.ts'
import { ProgressMeter, StageStatusChip } from './StageBits.tsx'

export interface StageRailProps {
  projectId: string
  stages: SdlcStage[]
  states: StageState[]
  checklist: ChecklistItem[]
  currentStage: string
  selectedStage: string
}

/**
 * Vertical stage list on desktop, horizontal stepper on narrow screens.
 * Arrow keys move between stages; Enter opens one.
 */
export function StageRail({ projectId, stages, states, checklist, currentStage, selectedStage }: StageRailProps) {
  const listRef = useRef<HTMLOListElement | null>(null)

  // Keep the selected stage visible in the horizontal stepper.
  useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]')
    if (list == null || active == null || list.scrollWidth <= list.clientWidth) return
    const listBox = list.getBoundingClientRect()
    const box = active.getBoundingClientRect()
    list.scrollLeft += box.left - listBox.left - (listBox.width - box.width) / 2
  }, [selectedStage])

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(event.key)) return
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('.stage-rail-link') ?? [])
    const index = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (index === -1) return
    event.preventDefault()
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? links.length - 1
        : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length
    links[next]?.focus()
  }

  return (
    <nav className="stage-rail" aria-label="SDLC stages">
      <ol className="stage-rail-list" ref={listRef} onKeyDown={onKeyDown}>
        {stages.map((stage, index) => {
          const state = states.find((entry) => entry.stage === stage.key)
          const progress = requiredProgress(stageChecklist(checklist, stage.key))
          const isCurrent = stage.key === currentStage
          const selected = stage.key === selectedStage
          return (
            <li key={stage.key}>
              <a
                className="stage-rail-link"
                href={routeHref({ name: 'stage', projectId, stage: stage.key, runId: null })}
                aria-current={selected ? 'page' : undefined}
                data-current={isCurrent || undefined}
                data-status={state?.status ?? 'not_started'}
              >
                <span className="stage-rail-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span className="stage-rail-main">
                  <span className="stage-rail-name">
                    {stage.name}
                    {isCurrent && <span className="stage-rail-current">Current</span>}
                  </span>
                  <span className="stage-rail-meta">
                    <StageStatusChip status={state?.status ?? 'not_started'} />
                    {progress.total > 0 && <ProgressMeter done={progress.done} total={progress.total} label="Required items" />}
                  </span>
                </span>
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
