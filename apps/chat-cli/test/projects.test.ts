import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createProjectTools, PROJECT_TOOL_NAMES } from '../src/project-tools.ts'
import { ProjectError, ProjectService, type Project } from '../src/projects.ts'
import { SettingsError, SettingsService } from '../src/settings.ts'
import { MemoryProjectStore } from './support/memory-project-store.ts'
import { MemorySettingsStore } from './support/memory-settings-store.ts'

function tempDirs(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'aifactory-projects-'))
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('creates multiple active projects and updates them', async () => {
  const { root, cleanup } = tempDirs()
  try {
    const service = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const first = await service.create({
      name: 'Alpha',
      rootPath: root,
      organization: 'Acme',
      ownerEmail: 'owner@example.com',
      status: 'active',
    })
    assert.equal(first.status, 'active')
    assert.equal(first.organization, 'Acme')

    const secondDir = mkdtempSync(join(root, 'second-'))
    const second = await service.create({ name: 'Beta', rootPath: secondDir, status: 'active' })
    assert.equal(second.status, 'active')
    assert.equal((await service.list({ status: 'active' })).length, 2)

    const updated = await service.update(first.id, { name: 'Alpha 2', organization: 'Acme Labs' })
    assert.equal(updated.name, 'Alpha 2')
    assert.equal(updated.organization, 'Acme Labs')

    const archived = await service.changeStatus(second.id, 'archived')
    assert.equal(archived.status, 'archived')
    assert.equal((await service.list({ status: 'active' })).length, 1)

    await service.remove(first.id)
    await assert.rejects(() => service.get(first.id), (error: unknown) =>
      error instanceof ProjectError && error.status === 404)
  } finally {
    cleanup()
  }
})

test('exposes the six agent tools over the same service', async () => {
  const { root, cleanup } = tempDirs()
  try {
    const service = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const tools = createProjectTools(service)
    assert.deepEqual(tools.map((tool) => tool.name), PROJECT_TOOL_NAMES)

    const create = tools.find((tool) => tool.name === 'create_project')!
    const created = await create.execute({
      name: 'Tool Project',
      rootPath: root,
      organization: 'Acme',
      status: 'active',
    }) as { project: Project }
    assert.equal(created.project.name, 'Tool Project')

    const list = tools.find((tool) => tool.name === 'list_projects')!
    const listed = await list.execute({ status: 'active' }) as { projects: Project[] }
    assert.equal(listed.projects.length, 1)

    const status = tools.find((tool) => tool.name === 'change_project_status')!
    const changed = await status.execute({ id: created.project.id, status: 'inactive' }) as { project: Project }
    assert.equal(changed.project.status, 'inactive')

    const get = tools.find((tool) => tool.name === 'get_project')!
    const fetched = await get.execute({ id: created.project.id }) as { project: Project }
    assert.equal(fetched.project.id, created.project.id)

    const update = tools.find((tool) => tool.name === 'update_project')!
    const updated = await update.execute({ id: created.project.id, name: 'Tool Project 2' }) as { project: Project }
    assert.equal(updated.project.name, 'Tool Project 2')

    const remove = tools.find((tool) => tool.name === 'remove_project')!
    await remove.execute({ id: created.project.id })
    await assert.rejects(() => service.get(created.project.id), (error: unknown) =>
      error instanceof ProjectError && error.status === 404)
  } finally {
    cleanup()
  }
})

test('enforces the active-project limit and settings', async () => {
  const { root, cleanup } = tempDirs()
  try {
    const settings = new SettingsService(new MemorySettingsStore())
    const service = new ProjectService(new MemoryProjectStore(), settings)
    assert.equal((await settings.get()).maxActiveProjects, 3)

    const dirs = [1, 2, 3, 4, 5].map((index) => mkdtempSync(join(root, `p${index}-`)))
    const first = await service.create({ name: 'One', rootPath: dirs[0]!, status: 'active' })
    await service.create({ name: 'Two', rootPath: dirs[1]!, status: 'active' })
    await service.create({ name: 'Three', rootPath: dirs[2]!, status: 'active' })

    await assert.rejects(
      () => service.create({ name: 'Four', rootPath: dirs[3]!, status: 'active' }),
      (error: unknown) => error instanceof ProjectError && error.code === 'ACTIVE_PROJECT_LIMIT_REACHED',
    )

    const fourth = await service.create({ name: 'Four', rootPath: dirs[3]!, status: 'inactive' })
    await assert.rejects(
      () => service.changeStatus(fourth.id, 'active'),
      (error: unknown) => error instanceof ProjectError && error.code === 'ACTIVE_PROJECT_LIMIT_REACHED',
    )

    await service.changeStatus(first.id, 'on_hold')
    const activated = await service.changeStatus(fourth.id, 'active')
    assert.equal(activated.status, 'active')

    await assert.rejects(
      () => settings.update({ maxActiveProjects: 2 }, 3),
      (error: unknown) => error instanceof SettingsError
        && error.code === 'ACTIVE_LIMIT_BELOW_ACTIVE',
    )

    await service.changeStatus((await service.list({ status: 'active' }))[0]!.id, 'completed')
    const lowered = await settings.update({ maxActiveProjects: 2 }, await service.countActive())
    assert.equal(lowered.maxActiveProjects, 2)

    const fifth = await service.create({ name: 'Five', rootPath: dirs[4]!, status: 'inactive' })
    await assert.rejects(
      () => service.changeStatus(fifth.id, 'active'),
      (error: unknown) => error instanceof ProjectError && error.code === 'ACTIVE_PROJECT_LIMIT_REACHED',
    )

    const active = await service.list({ status: 'active' })
    await service.changeStatus(active[0]!.id, 'archived')
    const finalActive = await service.changeStatus(fifth.id, 'active')
    assert.equal(finalActive.status, 'active')
    assert.equal((await service.list({ status: 'active' })).length, 2)
  } finally {
    cleanup()
  }
})

test('validates project input and root paths', async () => {
  const { root, cleanup } = tempDirs()
  try {
    const service = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))

    await assert.rejects(
      () => service.create({ name: '', rootPath: root }),
      (error: unknown) => error instanceof ProjectError && error.code === 'INVALID_NAME',
    )
    await assert.rejects(
      () => service.create({ name: 'Relative', rootPath: 'relative/path' }),
      (error: unknown) => error instanceof ProjectError && error.code === 'INVALID_ROOT_PATH',
    )
    await assert.rejects(
      () => service.create({ name: 'Missing', rootPath: join(root, 'missing') }),
      (error: unknown) => error instanceof ProjectError && error.code === 'INVALID_ROOT_PATH',
    )
    await assert.rejects(
      () => service.create({ name: 'Mail', rootPath: root, ownerEmail: 'not-an-email' }),
      (error: unknown) => error instanceof ProjectError && error.code === 'INVALID_OWNER_EMAIL',
    )
    await assert.rejects(
      () => service.create({ name: 'Status', rootPath: root, status: 'unknown' as never }),
      (error: unknown) => error instanceof ProjectError && error.code === 'INVALID_STATUS',
    )
  } finally {
    cleanup()
  }
})
