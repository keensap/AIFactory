import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'x')
    await assert.rejects(
      () => service.create({ name: 'File', rootPath: file }),
      (error: unknown) => error instanceof ProjectError && error.code === 'INVALID_ROOT_PATH',
    )
    // A missing parent that is a file cannot become a directory.
    await assert.rejects(
      () => service.create({ name: 'Under', rootPath: join(file, 'child') }),
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

test('a missing project directory is created, including its parents', async () => {
  const { root, cleanup } = tempDirs()
  try {
    const service = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    const target = join(root, 'clients', 'acme', 'portal')
    const project = await service.create({ name: 'Acme portal', rootPath: target, status: 'active' })
    assert.equal(project.rootPath, target, 'the stored path is the real path of the new directory')
    assert.ok(statSync(target).isDirectory(), 'the directory now exists')

    // Creating the same path again reuses it; only the unique root path rule refuses.
    await assert.rejects(
      () => service.create({ name: 'Duplicate', rootPath: target, status: 'inactive' }),
      (error: unknown) => error instanceof ProjectError && error.code === 'ROOT_PATH_CONFLICT',
    )

    // Updating a project to a different, missing directory creates it too.
    const moved = join(root, 'clients', 'acme', 'portal-v2')
    const updated = await service.update(project.id, { rootPath: moved })
    assert.equal(updated.rootPath, moved)
    assert.ok(statSync(moved).isDirectory())

    // An existing directory is accepted unchanged.
    const existing = await service.create({ name: 'Existing', rootPath: root, status: 'inactive' })
    assert.equal(existing.rootPath, root)
  } finally { cleanup() }
})

test('creating a project leaves neighbouring files alone', async () => {
  const { root, cleanup } = tempDirs()
  try {
    const service = new ProjectService(new MemoryProjectStore(), new SettingsService(new MemorySettingsStore()))
    writeFileSync(join(root, 'marker.txt'), 'keep me')
    const created = await service.create({ name: 'New', rootPath: join(root, 'existing-project'), status: 'inactive' })
    assert.equal(created.rootPath, join(root, 'existing-project'))
    assert.equal(statSync(join(root, 'marker.txt')).isFile(), true)
  } finally { cleanup() }
})
