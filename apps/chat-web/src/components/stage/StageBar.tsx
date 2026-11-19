import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { StageBarItem } from '../../data/stageBar.ts'
import { CheckIcon } from '../Icons.tsx'
import { routeHref } from '../../lib/router.ts'

export interface StageBarProps {
  projectId: string
  items: StageBarItem[]
  summary: string
}

/**
 * Horizontal SDLC stage boxes. Done and current stages are links; later ones
 * are disabled (not focusable, not links). The current stage is highlighted;
 * the one on screen gets `aria-current="page"` (a ring when it is a past stage).
 * Arrow keys move between enabled stages.
 */
export function StageBar({ projectId, items, summary }: StageBarProps) {
  const listRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('[aria-current="page"]')
    if (list == null || active == null || list.scrollWidth <= list.clientWidth) return
    const listBox = list.getBoundingClientRect()
    const box = active.getBoundingClientRect()
    list.scrollLeft += box.left - listBox.left - (listBox.width - box.width) / 2
  }, [items])

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('a.stage-box') ?? [])
    const index = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (index === -1) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length
    links[next]?.focus()
  }

  return (
    <nav className="stage-bar" aria-label="SDLC stages">
      <ol className="stage-bar-list" ref={listRef} onKeyDown={onKeyDown}>
        {items.map((item) => {
          const number = String(item.number).padStart(2, '0')
          const tag = item.status === 'done' ? <><CheckIcon size={11} /> Done</> : item.status === 'current' ? 'Current' : null
          const inner = (
            <>
              <span className="stage-box-no" aria-hidden="true">{number}{tag !== null && <> · {tag}</>}</span>
              <span className="stage-box-name">{item.name}</span>
            </>
          )
          return (
            <li key={item.key}>
              {item.enabled ? (
                <a
                  className="stage-box"
                  data-status={item.status}
                  href={routeHref({ name: 'stage', projectId, stage: item.key, runId: null })}
                  aria-current={item.selected ? 'page' : undefined}
                  data-executable={item.executable}
                  title={item.status === 'done' ? `${item.name} — completed (read-only)` : `${item.name} — current stage (${item.executable ? 'runs available' : 'read-only'})`}
                >
                  {inner}
                  <span className="sr-only">{item.status === 'done' ? ', completed, read-only' : ', current stage'}</span>
                </a>
              ) : (
                <span className="stage-box" data-status="todo" aria-disabled="true" title={`${item.name} — not started`}>
                  {inner}
                  <span className="sr-only">, not started</span>
                </span>
              )}
            </li>
          )
        })}
      </ol>
      <p className="sr-only">{summary}</p>
    </nav>
  )
}
