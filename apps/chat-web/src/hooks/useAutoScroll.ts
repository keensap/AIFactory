import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export interface AutoScrollController {
  ref: RefObject<HTMLDivElement>
  atBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

/**
 * Keep a transcript pinned to the bottom while it streams, but never yank the
 * viewport when the reader has scrolled up.
 */
export function useAutoScroll(deps: readonly unknown[]): AutoScrollController {
  const ref = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const previousHeight = useRef(0)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = ref.current
    if (element === null) return
    element.scrollTo({ top: element.scrollHeight, behavior })
    atBottomRef.current = true
    setAtBottom(true)
  }, [])

  useEffect(() => {
    const element = ref.current
    if (element === null) return

    const measure = (): void => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      const near = distance < 72
      atBottomRef.current = near
      setAtBottom(near)
    }

    const onScroll = (): void => {
      measure()
    }

    element.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      element.removeEventListener('scroll', onScroll)
    }
  }, [])

  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const height = element.scrollHeight
    const grew = height > previousHeight.current
    previousHeight.current = height
    if (grew && atBottomRef.current) {
      element.scrollTop = element.scrollHeight
    }
    // The deps array intentionally tracks transcript content, not the element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { ref, atBottom, scrollToBottom }
}
