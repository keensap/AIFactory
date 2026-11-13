/**
 * Tool descriptors for agent use.
 *
 * The same ProjectService backs the HTTP routes and these tools. A DSH plugin
 * (or MCP server) can register these definitions later without reimplementing
 * validation or SQL. Tool names are stable and match the product vocabulary:
 * create_project, change_project_status, get_project, list_projects,
 * update_project, remove_project.
 */

import {
  ProjectError,
  type ProjectListFilter,
  type ProjectService,
  type ProjectStatus,
} from './projects.ts'

export type ProjectToolName =
  | 'create_project'
  | 'change_project_status'
  | 'get_project'
  | 'list_projects'
  | 'update_project'
  | 'remove_project'

export interface ProjectToolDefinition {
  name: ProjectToolName
  description: string
  inputSchema: Record<string, unknown>
  execute(input: unknown): Promise<unknown>
}

export const PROJECT_TOOL_NAMES: ProjectToolName[] = [
  'create_project',
  'change_project_status',
  'get_project',
  'list_projects',
  'update_project',
  'remove_project',
]

const PROJECT_ID_SCHEMA = { type: 'string', format: 'uuid' }
const PROJECT_STATUS_SCHEMA = { type: 'string', enum: ['active', 'inactive', 'archived', 'completed', 'on_hold'] }

export function createProjectTools(service: ProjectService): ProjectToolDefinition[] {
  return [
    {
      name: 'create_project',
      description: 'Create a project from a name and an existing absolute root directory.',
      inputSchema: {
        type: 'object',
        required: ['name', 'rootPath'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          rootPath: { type: 'string', description: 'Absolute path to an existing directory.' },
          organization: { type: ['string', 'null'] },
          ownerEmail: { type: ['string', 'null'], format: 'email' },
          status: PROJECT_STATUS_SCHEMA,
        },
      },
      execute: async (input) => ({ project: await service.create(input) }),
    },
    {
      name: 'change_project_status',
      description: 'Change a project status without touching its other fields.',
      inputSchema: {
        type: 'object',
        required: ['id', 'status'],
        properties: { id: PROJECT_ID_SCHEMA, status: PROJECT_STATUS_SCHEMA },
      },
      execute: async (input) => {
        const record = asObject(input)
        return { project: await service.changeStatus(readId(record), record.status) }
      },
    },
    {
      name: 'get_project',
      description: 'Read one project by id.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: PROJECT_ID_SCHEMA },
      },
      execute: async (input) => ({ project: await service.get(readId(asObject(input))) }),
    },
    {
      name: 'list_projects',
      description: 'List projects, optionally filtered by status or organization.',
      inputSchema: {
        type: 'object',
        properties: {
          status: PROJECT_STATUS_SCHEMA,
          organization: { type: 'string' },
        },
      },
      execute: async (input) => {
        const record = input === undefined ? {} : asObject(input)
        const filter: ProjectListFilter = {}
        if (typeof record.status === 'string') filter.status = record.status as ProjectStatus
        if (typeof record.organization === 'string') filter.organization = record.organization
        return { projects: await service.list(filter) }
      },
    },
    {
      name: 'update_project',
      description: 'Update project fields. Omitted fields are left unchanged.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: PROJECT_ID_SCHEMA,
          name: { type: 'string', minLength: 1, maxLength: 200 },
          rootPath: { type: 'string' },
          organization: { type: ['string', 'null'] },
          ownerEmail: { type: ['string', 'null'], format: 'email' },
          status: PROJECT_STATUS_SCHEMA,
        },
      },
      execute: async (input) => {
        const record = asObject(input)
        const id = readId(record)
        const patch: Record<string, unknown> = {}
        for (const key of ['name', 'rootPath', 'organization', 'ownerEmail', 'status']) {
          if (record[key] !== undefined) patch[key] = record[key]
        }
        return { project: await service.update(id, patch) }
      },
    },
    {
      name: 'remove_project',
      description: 'Remove a project registry row. The root directory is not deleted.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: PROJECT_ID_SCHEMA },
      },
      execute: async (input) => {
        const id = readId(asObject(input))
        await service.remove(id)
        return { removed: true, id }
      },
    },
  ]
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectError(400, 'INVALID_TOOL_INPUT', 'tool input must be an object')
  }
  return value as Record<string, unknown>
}

function readId(record: Record<string, unknown>): string {
  if (typeof record.id !== 'string' || record.id === '') {
    throw new ProjectError(400, 'INVALID_PROJECT_ID', 'id is required')
  }
  return record.id
}
