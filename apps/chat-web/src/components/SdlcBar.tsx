import { useEffect, useRef } from 'react'
import { SDLC_STAGES, stageState, type SdlcStage } from '../data/sdlc.ts'
import { CheckIcon } from './Icons.tsx'

export interface SdlcBarProps {
  currentIndex: number
  onSelect: (index: number) => void
  /** Defaults to the local stage list. */
  stages?: readonly SdlcStage[]
  /** Tooltip suffix for non-current stages. */
  selectHint?: string
  /** Clicking the current stage also calls `onSelect` (e.g. to open it). */
  selectCurrent?: boolean
}

/**
 * 30px stage strip under the project header: completed stages are coloured,
 * the current stage glows, upcoming stages are grey. Click a stage to make it
 * the current one.
 */
export function SdlcBar({
  currentIndex,
  onSelect,
  stages = SDLC_STAGES,
  selectHint = 'click to set as current',
  selectCurrent = false,
}: SdlcBarProps) {
  const current = stages[currentIndex]
  const barRef = useRef<HTMLElement | null>(null)

  // On narrow screens the strip scrolls; keep the current stage centred,
  // including after the bar is resized (rotation, window resize).
  useEffect(() => {
    const bar = barRef.current
    if (bar == null) return
    const centre = (): void => {
      const active = bar.querySelector<HTMLElement>('.sdlc-stage[data-state="current"]')
      if (active == null || bar.scrollWidth <= bar.clientWidth) return
      const barBox = bar.getBoundingClientRect()
      const box = active.getBoundingClientRect()
      bar.scrollLeft += box.left - barBox.left - (barBox.width - box.width) / 2
    }
    centre()
    const observer = new ResizeObserver(centre)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [currentIndex])

  return (
    <nav className="sdlc-bar" aria-label="SDLC stage" ref={barRef}>
      <ol className="sdlc-stages">
        {stages.map((stage, index) => {
          const state = stageState(index, currentIndex)
          return (
            <li key={stage.id} className="sdlc-item">
              <button
                type="button"
                className="sdlc-stage"
                data-state={state}
                aria-current={state === 'current' ? 'step' : undefined}
                title={`${stage.label}: ${stage.description}${state === 'current' ? ' (current)' : ` — ${selectHint}`}`}
                onClick={() => {
                  if (state !== 'current' || selectCurrent) onSelect(index)
                }}
              >
                {state === 'completed' && <CheckIcon size={10} strokeWidth={2.6} />}
                <span>{stage.label}</span>
              </button>
            </li>
          )
        })}
      </ol>
      <span className="sr-only" aria-live="polite">
        {current === undefined ? '' : `Current stage: ${current.label}`}
      </span>
    </nav>
  )
}
