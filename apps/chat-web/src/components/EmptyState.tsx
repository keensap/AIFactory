import type { Project } from '../data/projects.ts'
import type { ApiHealthState } from '../hooks/useApiHealth.ts'
import type { ProjectsMode } from '../hooks/useProjects.ts'
import {
  ArrowUpRightIcon,
  BrandMark,
  CodeIcon,
  InfoIcon,
  LayersIcon,
  SparklesIcon,
  WifiOffIcon,
} from './Icons.tsx'

export interface EmptyStateProps {
  project: Project
  projectsMode: ProjectsMode
  health: ApiHealthState
  onSuggestion: (prompt: string) => void
  onOpenSettings: () => void
  onRetryHealth: () => void
  onCreateProject: () => void
}

const SUGGESTIONS = [
  {
    icon: LayersIcon,
    title: 'Plan the next slice',
    detail: 'Break the next milestone into a short, ordered delivery plan.',
    prompt: 'Plan the next slice for this project. List the smallest useful milestones and the main risks.',
  },
  {
    icon: SparklesIcon,
    title: 'Summarize the project',
    detail: 'Turn the current context into a status update for the team.',
    prompt: 'Summarize this project for a weekly status update: goals, current state, risks and next steps.',
  },
  {
    icon: CodeIcon,
    title: 'Review the API surface',
    detail: 'Look for gaps, inconsistencies and missing failure cases.',
    prompt: 'Review the Chat API surface for gaps. Focus on error handling, streaming semantics and UI integration.',
  },
  {
    icon: ArrowUpRightIcon,
    title: 'Draft a release checklist',
    detail: 'Capture the gates that should pass before this ships.',
    prompt: 'Draft a practical release checklist for this project, including verification, rollback and documentation gates.',
  },
]

export function EmptyState({
  project,
  projectsMode,
  health,
  onSuggestion,
  onOpenSettings,
  onRetryHealth,
  onCreateProject,
}: EmptyStateProps) {
  const offline = health.status === 'offline' || health.status === 'unauthorized'
  const isUnfiled = project.source === 'unfiled'
  const projectNote = projectsMode === 'api'
    ? 'Projects are registered in PostgreSQL. New chats run in the project root and stay bound to it.'
    : projectsMode === 'loading'
      ? 'Checking the projects registry…'
      : 'Project metadata is a local placeholder until the projects registry is available. Chats are stored by the Chat API.'
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">
        <BrandMark size={58} />
      </div>
      <div className="empty-project-pill">
        <span className="project-dot" data-color={project.color} aria-hidden="true">
          {project.name.slice(0, 1).toUpperCase()}
        </span>
        {project.name}
      </div>
      <h1>
        {isUnfiled
          ? 'What should we work on?'
          : (
              <>
                What should we build
                <br />
                in {project.name}?
              </>
            )}
      </h1>
      <p className="empty-copy">
        Ask a question, sketch a design, or hand the harness a task. Every turn runs
        against the AI Factory Chat API and keeps its session {isUnfiled ? 'in this chat group' : 'in this project'}.
      </p>

      {isUnfiled && (
        <div className="inline-notice" data-tone="info">
          <InfoIcon size={17} />
          <div>
            <strong>No registered project selected</strong>
            <p>
              Create a project to register a root directory, or keep chatting under
              Unfiled. Chats are stored by the Chat API either way.
            </p>
          </div>
          <div className="inline-notice-actions">
            <button type="button" className="button button-secondary button-sm" onClick={onCreateProject}>
              Create project
            </button>
          </div>
        </div>
      )}

      {offline && (
        <div className="inline-notice" data-tone="warning">
          <WifiOffIcon size={17} />
          <div>
            <strong>
              {health.status === 'unauthorized' ? 'The API needs a token' : 'The Chat API is unreachable'}
            </strong>
            <p>{health.error ?? 'Check that the API is running and the URL is correct.'}</p>
          </div>
          <div className="inline-notice-actions">
            {health.status === 'offline' && (
              <button type="button" className="button button-ghost button-sm" onClick={onRetryHealth}>
                Retry
              </button>
            )}
            <button type="button" className="button button-secondary button-sm" onClick={onOpenSettings}>
              Settings
            </button>
          </div>
        </div>
      )}

      <div className="suggestion-grid">
        {SUGGESTIONS.map((suggestion) => {
          const Icon = suggestion.icon
          return (
            <button
              key={suggestion.title}
              type="button"
              className="suggestion-card"
              onClick={() => onSuggestion(suggestion.prompt)}
            >
              <span className="suggestion-icon"><Icon size={17} /></span>
              <span className="suggestion-body">
                <span className="suggestion-title">{suggestion.title}</span>
                <span className="suggestion-detail">{suggestion.detail}</span>
              </span>
            </button>
          )
        })}
      </div>

      <p className="empty-note">
        <InfoIcon size={14} />
        <span>{projectNote}</span>
      </p>
    </div>
  )
}
