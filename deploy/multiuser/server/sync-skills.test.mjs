import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importSkills, shouldCopyPath } from './sync-skills.mjs'

async function unlockTree(root) {
  const directory = await opendir(root).catch(() => undefined)
  if (directory === undefined) return
  for await (const entry of directory) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) await unlockTree(path)
  }
  await chmod(root, 0o755)
}

test('excludes credentials, caches, generated output, and duplicate packages', () => {
  assert.equal(shouldCopyPath('/repo/skill/.env', false), false)
  assert.equal(shouldCopyPath('/repo/skill/.env.local', false), false)
  assert.equal(shouldCopyPath('/repo/skill/.env.example', false), true)
  assert.equal(shouldCopyPath('/repo/skill/outputs', true), false)
  assert.equal(shouldCopyPath('/repo/skill/outputs-2026', true), false)
  assert.equal(shouldCopyPath('/repo/skill/tests/cassettes', true), false)
  assert.equal(shouldCopyPath('/repo/skill/archive.skill', false), false)
  assert.equal(shouldCopyPath('/repo/skill/SKILL.md', false), true)
})

test('imports a locked shared skills snapshot and replaces the old snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sync-skills-'))
  const source = join(root, 'source')
  const destination = join(root, 'shared/skills')
  const stateRoot = join(root, 'state')
  try {
    await mkdir(join(source, 'skill-a/scripts'), { recursive: true })
    await mkdir(join(source, 'skill-a/outputs'), { recursive: true })
    await mkdir(join(source, 'skill-a/tests/cassettes'), { recursive: true })
    await mkdir(join(source, 'skill-b/references'), { recursive: true })
    await mkdir(join(source, '.skills-manager'), { recursive: true })
    await mkdir(join(source, 'not-a-skill'), { recursive: true })
    await writeFile(join(source, 'skill-a/SKILL.md'), '# Skill A\n')
    await writeFile(join(source, 'skill-a/.env'), 'SECRET=value\n')
    await writeFile(join(source, 'skill-a/.env.example'), 'SECRET=\n')
    await writeFile(join(source, 'skill-a/outputs/result.txt'), 'generated\n')
    await writeFile(join(source, 'skill-a/tests/cassettes/api.yaml'), 'fixture\n')
    await writeFile(join(source, 'skill-a/archive.skill'), 'duplicate\n')
    await writeFile(join(source, 'skill-a/scripts/run.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(source, 'skill-a/scripts/run.sh'), 0o755)
    await writeFile(join(source, 'skill-b/SKILL.md'), '# Skill B\n')
    await writeFile(join(source, 'skill-b/references/guide.md'), 'guide\n')
    await writeFile(join(source, '.skills-manager/protocol.json'), '{}\n')
    await writeFile(join(source, 'not-a-skill/README.md'), 'not imported\n')

    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'old.txt'), 'old\n')

    const result = await importSkills(source, destination, {
      stateRoot,
      commit: 'test-commit',
    })
    assert.equal(result.skills, 2)
    assert.equal(result.commit, 'test-commit')
    assert.equal(await readFile(join(destination, 'skill-a/SKILL.md'), 'utf8'), '# Skill A\n')
    assert.equal(await readFile(join(destination, 'skill-b/SKILL.md'), 'utf8'), '# Skill B\n')
    assert.equal(await readFile(join(destination, 'skill-a/.env.example'), 'utf8'), 'SECRET=\n')
    await assert.rejects(readFile(join(destination, 'skill-a/.env'), 'utf8'))
    await assert.rejects(readFile(join(destination, 'skill-a/outputs/result.txt'), 'utf8'))
    await assert.rejects(
      readFile(join(destination, 'skill-a/tests/cassettes/api.yaml'), 'utf8'),
    )
    await assert.rejects(readFile(join(destination, 'old.txt'), 'utf8'))
    assert.equal((await stat(destination)).mode & 0o777, 0o555)
    assert.equal((await stat(join(destination, 'skill-a'))).mode & 0o777, 0o555)
    assert.equal((await stat(join(destination, 'skill-a/SKILL.md'))).mode & 0o777, 0o444)
    assert.equal(
      (await stat(join(destination, 'skill-a/scripts/run.sh'))).mode & 0o777,
      0o555,
    )

    const second = await importSkills(source, destination, {
      stateRoot,
      commit: 'second-commit',
    })
    assert.equal(second.skills, 2)
    assert.equal(second.commit, 'second-commit')
    assert.equal((await stat(destination)).mode & 0o777, 0o555)
    assert.equal(await readFile(join(destination, 'skill-a/SKILL.md'), 'utf8'), '# Skill A\n')
  } finally {
    await unlockTree(destination)
    await rm(root, { recursive: true, force: true })
  }
})
