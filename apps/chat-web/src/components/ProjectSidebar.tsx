import type { ProjectStatus } from '../api/types.ts'
import { projectStatusLabel, type Project } from '../data/projects.ts'
import { formatFullDate, truncate } from '../lib/format.ts'
import { routeHref } from '../lib/router.ts'
import {
  ArrowLeftIcon,
  ClockIcon,
  CloseIcon,
  CodeIcon,
  FolderIcon,
  MailIcon,
  PencilIcon,
  SettingsIcon,
  TrashIcon,
  UsersIcon,
  ListIcon,
} from './Icons.tsx'

export interface ProjectSidebarProps {
  project: Project
  canDelete: boolean
  mobileOpen: boolean
  onCloseMobile: () => void
  onSetStatus: (status: ProjectStatus) => void
  onEdit: () => void
  onDelete: () => void
}

const STATUSES: readonly ProjectStatus[] = ['active', 'inactive', 'archived']

/** Left rail of the project workspace. Holds project settings only. */
export function ProjectSidebar({
  project,
  canDelete,
  mobileOpen,
  onCloseMobile,
  onSetStatus,
  onEdit,
  onDelete,
}: ProjectSidebarProps) {
  const isApi = project.source === 'api'

  return (
    <aside className="project-sidebar" data-mobile-open={mobileOpen || undefined} aria-label="Project settings">
      <div className="project-sidebar-top">
        <a className="back-link" href={routeHref({ name: 'home' })}>
          <ArrowLeftIcon size={15} /> All projects
        </a>
        <button
          type="button"
          className="icon-button project-sidebar-close"
          aria-label="Close project settings"
          onClick={onCloseMobile}
        >
          <CloseIcon size={17} />
        </button>
      </div>

      <div className="project-sidebar-hero">
        <span className="project-avatar" data-color={project.color} aria-hidden="true">
          {project.name.trim().slice(0, 1).toUpperCase() || '?'}
        </span>
        <div>
          <h2>{truncate(project.name, 40)}</h2>
          <span className="project-sidebar-source">{isApi ? 'Project registry' : 'Saved in this browser'}</span>
        </div>
      </div>

      <div className="project-sidebar-scroll">
        <h3 className="eyebrow project-sidebar-heading">
          <SettingsIcon size={13} /> Project settings
        </h3>

        <dl className="detail-list">
          <div className="detail-row detail-row-stacked">
            <dt><FolderIcon size={14} /> Directory</dt>
            <dd className="mono" title={project.workspace}>{project.workspace === '' ? '—' : project.workspace}</dd>
          </div>
          {isApi && (
            <>
              <div className="detail-row">
                <dt><UsersIcon size={14} /> Organization</dt>
                <dd>{project.organization ?? '—'}</dd>
              </div>
              <div className="detail-row">
                <dt><MailIcon size={14} /> Owner</dt>
                <dd>{project.ownerEmail ?? '—'}</dd>
              </div>
            </>
          )}
          <div className="detail-row">
            <dt><ClockIcon size={14} /> Created</dt>
            <dd>{formatFullDate(project.createdAt)}</dd>
          </div>
        </dl>

        {isApi && (
          <div className="settings-block">
            <span className="settings-label"><CodeIcon size={14} /> Status</span>
            <div className="status-switch" role="radiogroup" aria-label="Project status">
              {STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  role="radio"
                  aria-checked={project.status === status}
                  className="status-pill"
                  data-status={status}
                  data-selected={project.status === status || undefined}
                  onClick={() => {
                    if (project.status !== status) onSetStatus(status)
                  }}
                >
                  {projectStatusLabel(status)}
                </button>
              ))}
            </div>
          </div>
        )}

        {isApi && (
          <a className="button button-secondary button-sm sidebar-logs-link" href={routeHref({ name: 'logs', projectId: project.id, search: '' })}>
            <ListIcon size={14} /> View project logs
          </a>
        )}

        <div className="settings-placeholder">
          More project settings will appear here.
        </div>
      </div>

      <div className="project-sidebar-foot">
        <button type="button" className="button button-secondary button-sm" onClick={onEdit}>
          <PencilIcon size={14} /> Edit project
        </button>
        <button
          type="button"
          className="button button-danger-ghost button-sm"
          onClick={onDelete}
          disabled={!canDelete}
          title={canDelete ? 'Delete this project (the directory is never touched)' : 'This project cannot be deleted'}
        >
          <TrashIcon size={14} /> Delete
        </button>
      </div>
    </aside>
  )
}
