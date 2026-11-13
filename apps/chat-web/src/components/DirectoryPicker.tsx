import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, errorMessage, type ChatApi } from '../api/client.ts'
import type { DirectoryListing } from '../api/types.ts'
import { ArrowLeftIcon, ChevronRightIcon, FolderIcon, HomeIcon, RefreshIcon } from './Icons.tsx'
import { Modal } from './Modal.tsx'

export interface DirectoryPickerProps {
  open: boolean
  api: ChatApi
  /** Starting directory; defaults to the API host's home directory. */
  initialPath?: string
  onClose: () => void
  onSelect: (path: string) => void
}

/**
 * Browses directories on the API host (`GET /api/fs/directories`). Browsers
 * can't expose real local paths, and the project root has to be a path the
 * API host can open, so the server does the listing.
 */
export function DirectoryPicker({ open, api, initialPath, onClose, onSelect }: DirectoryPickerProps) {
  const [listing, setListing] = useState<DirectoryListing | undefined>()
  const [selected, setSelected] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [unsupported, setUnsupported] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [goTo, setGoTo] = useState('')
  const requestRef = useRef(0)

  const load = useCallback(async (path: string | undefined) => {
    const request = ++requestRef.current
    setLoading(true)
    setError(undefined)
    try {
      const next = await api.listDirectories(path, { showHidden })
      if (request !== requestRef.current) return
      setListing(next)
      setSelected(undefined)
      setGoTo(next.path)
      setUnsupported(false)
    } catch (caught) {
      if (request !== requestRef.current) return
      if (caught instanceof ApiError && caught.status === 404 && caught.code === 'NOT_FOUND') {
        setUnsupported(true)
      } else {
        setError(errorMessage(caught))
      }
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [api, showHidden])

  // Load when opened, and reload in place when the hidden toggle changes.
  useEffect(() => {
    if (!open) return
    void load(listing?.path ?? (initialPath?.startsWith('/') === true ? initialPath : undefined))
  }, [open, showHidden])

  useEffect(() => {
    if (!open) {
      requestRef.current += 1
      setListing(undefined)
      setSelected(undefined)
      setError(undefined)
    }
  }, [open])

  const choice = selected ?? listing?.path
  const crumbs = listing === undefined ? [] : breadcrumbs(listing.path)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose project directory"
      description="Folders on the machine running the Chat API. The harness runs inside the folder you choose."
      footer={(
        <>
          <span className="picker-choice mono" title={choice}>{choice ?? ''}</span>
          <button type="button" className="button button-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="button button-primary"
            disabled={choice === undefined || unsupported}
            onClick={() => {
              if (choice !== undefined) onSelect(choice)
            }}
          >
            Select folder
          </button>
        </>
      )}
    >
      {unsupported ? (
        <p className="form-error">
          This API doesn’t support directory browsing yet (it needs <code>GET /api/fs/directories</code>).
          Type the absolute path in the form instead.
        </p>
      ) : (
        <div className="picker">
          <form
            className="picker-goto"
            onSubmit={(event) => {
              event.preventDefault()
              void load(goTo.trim())
            }}
          >
            <button
              type="button"
              className="icon-button"
              aria-label="Parent folder"
              title="Parent folder"
              disabled={listing?.parent == null || loading}
              onClick={() => listing?.parent != null && void load(listing.parent)}
            >
              <ArrowLeftIcon size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Home folder"
              title="Home folder"
              disabled={loading}
              onClick={() => void load(listing?.home)}
            >
              <HomeIcon size={16} />
            </button>
            <input
              className="text-input mono"
              aria-label="Go to path"
              value={goTo}
              onChange={(event) => setGoTo(event.target.value)}
              spellCheck={false}
            />
            <button type="submit" className="button button-secondary" disabled={loading}>Go</button>
          </form>

          {crumbs.length > 0 && (
            <nav className="picker-crumbs" aria-label="Current folder">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="picker-crumb">
                  {index > 0 && <ChevronRightIcon size={12} />}
                  <button type="button" onClick={() => void load(crumb.path)}>{crumb.label}</button>
                </span>
              ))}
            </nav>
          )}

          {error !== undefined && <p className="form-error" role="alert">{error}</p>}

          <div className="picker-list" role="listbox" aria-label="Folders" aria-busy={loading}>
            {loading && listing === undefined && <p className="picker-empty">Loading…</p>}
            {listing !== undefined && listing.entries.length === 0 && !loading && (
              <p className="picker-empty">No subfolders. You can select this folder.</p>
            )}
            {listing?.entries.map((entry) => (
              <div key={entry.path} className="picker-row" data-selected={selected === entry.path || undefined}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected === entry.path}
                  className="picker-item"
                  onClick={() => setSelected(entry.path)}
                  onDoubleClick={() => void load(entry.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight') void load(entry.path)
                  }}
                >
                  <FolderIcon size={15} />
                  <span>{entry.name}</span>
                </button>
                <button
                  type="button"
                  className="picker-open"
                  aria-label={`Open ${entry.name}`}
                  title={`Open ${entry.name}`}
                  onClick={() => void load(entry.path)}
                >
                  <ChevronRightIcon size={14} />
                </button>
              </div>
            ))}
            {listing?.truncated === true && (
              <p className="picker-empty">Showing the first 1000 folders. Type a path to go deeper.</p>
            )}
          </div>

          <div className="picker-foot">
            <label className="check">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(event) => setShowHidden(event.target.checked)}
              />
              Show hidden folders
            </label>
            <span className="field-hint">Click to select · double-click (or →) to open</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh"
              title="Refresh"
              disabled={loading}
              onClick={() => void load(listing?.path)}
            >
              <RefreshIcon size={15} />
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function breadcrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  const crumbs = [{ label: '/', path: '/' }]
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}
