import type { ApiProject } from '../../api/types.ts'
import type { Project } from '../../data/projects.ts'
import { CopyField } from './StageBits.tsx'
import { routeHref } from '../../lib/router.ts'
import { Skeleton } from './StageBits.tsx'
import { ListIcon, PencilIcon, SettingsIcon } from '../Icons.tsx'

export interface ProjectPanelProps {
  project: Project
  apiProject: ApiProject | null
  onOpenSettings: () => void
  /** Opens the stage settings popup; the link is omitted when absent. */
  onOpenStageSettings?: () => void
}

/** Links that don't have an API behind them yet: shown disabled with "soon". */
const SOON_LINKS = ['Documents', 'Images', 'Directories', 'Repository']

/** Left column: project info, links and project settings. */
export function ProjectPanel({ project, apiProject, onOpenSettings, onOpenStageSettings }: ProjectPanelProps) {
  const rows: [string, string][] = apiProject === null ? [] : [
    ['Status', apiProject.status],
    ['Organization', apiProject.organization ?? '—'],
    ['Owner', apiProject.ownerEmail ?? '—'],
    ['Created', new Date(apiProject.createdAt).toLocaleDateString()],
  ]
  return (
    <aside className="proj-panel" aria-label="Project">
      <section>
        <h3 className="pp-title">Project</h3>
        <p className="pp-name">
          {project.name}
          <button type="button" className="icon-button pp-edit" aria-label="Edit project" title="Edit project" onClick={onOpenSettings}>
            <PencilIcon size={14} />
          </button>
        </p>
        {apiProject === null ? <Skeleton lines={4} /> : (
          <dl className="pp-list">
            {rows.map(([term, value]) => <div key={term}><dt>{term}</dt><dd className={term === 'Status' ? 'capitalize' : undefined}>{value}</dd></div>)}
            <div><dt>Root</dt><dd><CopyField value={apiProject.rootPath} label="root path" /></dd></div>
          </dl>
        )}
      </section>

      <section>
        <h3 className="pp-title">Links</h3>
        <ul className="pp-links">
          <li><a href={routeHref({ name: 'logs', projectId: project.id, search: '' })}><ListIcon size={15} /> Logs</a></li>
          {SOON_LINKS.map((label) => (
            <li key={label}>
              <span className="pp-soon" aria-disabled="true">{label}<span className="pp-soon-tag">soon</span></span>
            </li>
          ))}
        </ul>
      </section>

      <section className="pp-settings">
        <button type="button" className="pp-settings-button" onClick={onOpenSettings}>
          <SettingsIcon size={15} /> Project settings
        </button>
        {onOpenStageSettings !== undefined && (
          <button type="button" className="pp-settings-button" onClick={onOpenStageSettings}>
            <SettingsIcon size={15} /> Stage settings
          </button>
        )}
      </section>
    </aside>
  )
}
