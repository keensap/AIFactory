import type { ApiHealthState } from '../hooks/useApiHealth.ts'
import type { ProjectsMode } from '../hooks/useProjects.ts'
import { AppHeader } from '../components/AppHeader.tsx'
import {
  ChevronRightIcon,
  ClockIcon,
  FolderIcon,
  FolderPlusIcon,
  InfoIcon,
  MessageIcon,
  UsersIcon,
} from '../components/Icons.tsx'
import { projectStatusLabel, type Project } from '../data/projects.ts'
import { formatRelativeTime, pluralize, truncate } from '../lib/format.ts'
import { routeHref } from '../lib/router.ts'

export interface ProjectActivity {
  chats: number
  /** ISO time of the newest chat, if any. */
  lastActivity?: string
}

export interface LandingPageProps {
  projects: Project[]
  projectsMode: ProjectsMode
  projectsError?: string
  activity: Map<string, ProjectActivity>
  health: ApiHealthState
  theme: 'light' | 'dark'
  onOpenSettings: () => void
  onToggleTheme: () => void
}

/** Local placeholder projects have no status; treat them as active. */
export function isActiveProject(project: Project): boolean {
  return project.status === undefined || project.status === 'active'
}

export function LandingPage({
  projects,
  projectsMode,
  projectsError,
  activity,
  health,
  theme,
  onOpenSettings,
  onToggleTheme,
}: LandingPageProps) {
  const active = projects.filter(isActiveProject)
  const rest = projects
    .filter((project) => !isActiveProject(project))
    .sort((a, b) => statusRank(a) - statusRank(b) || a.name.localeCompare(b.name))
  const loading = projectsMode === 'loading'

  return (
    <div className="page">
      <AppHeader
        health={health}
        theme={theme}
        onOpenSettings={onOpenSettings}
        onToggleTheme={onToggleTheme}
      />

      <main className="page-main">
        <section className="create-banner" aria-labelledby="create-banner-title">
          <div className="create-banner-icon" aria-hidden="true">
            <FolderPlusIcon size={26} />
          </div>
          <div className="create-banner-copy">
            <h1 id="create-banner-title">Start a new project</h1>
            <p>
              A project is a name plus a directory on this machine. Every chat you start in a
              project runs the harness inside that directory, so it can read and work on the
              code there. Your chats stay grouped under the project.
            </p>
          </div>
          <a className="button button-primary button-lg" href={routeHref({ name: 'create-project' })}>
            <FolderPlusIcon size={17} /> Create project
          </a>
        </section>

        {projectsMode === 'local' && (
          <p className="page-notice" role="status">
            <InfoIcon size={15} />
            <span>
              The project registry is unavailable{projectsError === undefined ? '' : ` (${projectsError})`}.
              Showing projects saved in this browser.{' '}
              <button type="button" className="text-button" onClick={onOpenSettings}>
                Connection settings
              </button>
            </span>
          </p>
        )}

        <section className="project-section" aria-labelledby="active-projects-title">
          <div className="section-head">
            <h2 id="active-projects-title">Active projects</h2>
            {!loading && <span className="section-count">{active.length}</span>}
          </div>

          {loading ? (
            <div className="project-cards" aria-busy="true" aria-label="Loading projects">
              {[0, 1, 2].map((key) => <div key={key} className="project-card skeleton-card" />)}
            </div>
          ) : active.length === 0 ? (
            <div className="section-empty">
              <p>
                {projects.length === 0
                  ? 'No projects yet. Create your first project to start chatting.'
                  : 'No active projects. Open a project below and set it to active.'}
              </p>
            </div>
          ) : (
            <div className="project-cards">
              {active.map((project) => (
                <ProjectCard key={project.id} project={project} activity={activity.get(project.id)} />
              ))}
            </div>
          )}
        </section>

        {rest.length > 0 && (
          <section className="project-section" aria-labelledby="other-projects-title">
            <div className="section-head">
              <h2 id="other-projects-title">Other projects</h2>
              <span className="section-count">{rest.length}</span>
            </div>
            <ul className="project-rows">
              {rest.map((project) => {
                const stats = activity.get(project.id)
                return (
                  <li key={project.id}>
                    <a
                      className="project-row-link"
                      href={routeHref({ name: 'project-home', projectId: project.id })}
                      data-status={project.status}
                    >
                      <span className="project-avatar small" data-color={project.color} aria-hidden="true">
                        {initial(project.name)}
                      </span>
                      <span className="project-row-name">{project.name}</span>
                      <span className="project-row-path mono">{truncate(project.workspace || '—', 60)}</span>
                      <span className="project-row-meta">{pluralize(stats?.chats ?? 0, 'chat')}</span>
                      <span className="status-pill" data-status={project.status}>
                        {projectStatusLabel(project.status)}
                      </span>
                      <ChevronRightIcon size={16} className="project-row-chevron" />
                    </a>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </main>
    </div>
  )
}

function ProjectCard({ project, activity }: { project: Project; activity: ProjectActivity | undefined }) {
  return (
    <a
      className="project-card"
      href={routeHref({ name: 'project-home', projectId: project.id })}
    >
      <div className="project-card-head">
        <span className="project-avatar" data-color={project.color} aria-hidden="true">
          {initial(project.name)}
        </span>
        <div className="project-card-title">
          <h3>{truncate(project.name, 48)}</h3>
          {project.organization != null && project.organization !== '' && (
            <span className="project-card-org">
              <UsersIcon size={12} /> {project.organization}
            </span>
          )}
        </div>
        {project.status !== undefined && (
          <span className="status-pill" data-status={project.status}>
            {projectStatusLabel(project.status)}
          </span>
        )}
      </div>
      <p className="project-card-path mono" title={project.workspace}>
        <FolderIcon size={14} />
        <span>{project.workspace === '' ? 'No directory' : project.workspace}</span>
      </p>
      {project.description !== '' && <p className="project-card-desc">{truncate(project.description, 140)}</p>}
      <div className="project-card-foot">
        <span><MessageIcon size={13} /> {pluralize(activity?.chats ?? 0, 'chat')}</span>
        <span>
          <ClockIcon size={13} />{' '}
          {activity?.lastActivity === undefined
            ? `Created ${formatRelativeTime(project.createdAt)}`
            : `Active ${formatRelativeTime(activity.lastActivity)}`}
        </span>
        <span className="project-card-open">Open <ChevronRightIcon size={14} /></span>
      </div>
    </a>
  )
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}

function statusRank(project: Project): number {
  return project.status === 'inactive' ? 0 : 1
}
