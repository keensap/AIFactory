import type { ReactNode } from 'react'
import type { ApiHealthState } from '../hooks/useApiHealth.ts'
import { routeHref } from '../lib/router.ts'
import { BrandMark, MoonIcon, SettingsIcon, SunIcon } from './Icons.tsx'

export interface AppHeaderProps {
  health: ApiHealthState
  theme: 'light' | 'dark'
  onOpenSettings: () => void
  onToggleTheme: () => void
  /** Optional trailing content before the actions (e.g. page title). */
  children?: ReactNode
}

/** Application header used on the landing and create-project pages. */
export function AppHeader({ health, theme, onOpenSettings, onToggleTheme, children }: AppHeaderProps) {
  return (
    <header className="app-header">
      <a className="app-header-brand" href={routeHref({ name: 'home' })} aria-label="AI Factory projects">
        <BrandMark size={34} className="brand-mark" />
        <span className="app-header-copy">
          <span className="app-header-name">AI Factory Chat</span>
          <span className="app-header-tagline">Project workspaces for the AI Factory harness</span>
        </span>
      </a>
      {children}
      <div className="app-header-actions">
        <button
          type="button"
          className="health-pill"
          data-status={health.status}
          onClick={onOpenSettings}
          title={health.error ?? 'Connection settings'}
        >
          <span className="status-dot" aria-hidden="true" />
          {healthLabel(health)}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <SettingsIcon size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <SunIcon size={17} /> : <MoonIcon size={17} />}
        </button>
      </div>
    </header>
  )
}

export function healthLabel(health: ApiHealthState): string {
  switch (health.status) {
    case 'online':
      return 'API online'
    case 'unauthorized':
      return 'Token required'
    case 'offline':
      return 'API offline'
    case 'checking':
      return 'Connecting'
  }
}
