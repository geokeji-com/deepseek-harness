#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_REPO_URL = 'https://github.com/nixyme/skills-manager-backup.git'
const DEFAULT_SOURCE_ROOT = '/home/dsh/skills-manager-backup'
const DEFAULT_DEST_ROOT = '/home/dsh/.local/share/deepseek-harness/shared/skills'
const DEFAULT_STATE_ROOT = '/home/dsh/.local/state/deepseek-harness'
const EXCLUDED_DIRS = new Set([
  '.git',
  '.skills-manager',
  '.codepilot-uploads',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'node_modules',
  'cassettes',
])

function runGit(args, { cwd } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || 'unknown git error'
    throw new Error(`git ${args[0]} failed: ${detail}`)
  }
  return result.stdout.trim()
}

export function shouldCopyPath(sourcePath, isDirectory) {
  const name = basename(sourcePath)
  if (isDirectory) {
    if (EXCLUDED_DIRS.has(name)) return false
    if (name === 'outputs' || name.startsWith('outputs-')) return false
    if (sourcePath.endsWith('/tests/cassettes')) return false
    return true
  }
  if (name === '.env') return false
  if (name.startsWith('.env.') && name !== '.env.example') return false
  if (name === '.DS_Store' || name.endsWith('.pyc') || name.endsWith('.skill')) return false
  return true
}

async function assertNoSymlinks(root) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`skills source contains unsupported symlink: ${join(root, entry.name)}`)
    }
    if (entry.isDirectory()) await assertNoSymlinks(join(root, entry.name))
  }
}

async function lockTree(root) {
  const directory = await opendir(root)
  for await (const entry of directory) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`staged skills contain unsupported symlink: ${path}`)
    }
    if (entry.isDirectory()) {
      await lockTree(path)
      await chmod(path, 0o555)
    } else if (entry.isFile()) {
      const metadata = await stat(path)
      await chmod(path, metadata.mode & 0o111 ? 0o555 : 0o444)
    }
  }
  await chmod(root, 0o555)
}

async function unlockTree(root) {
  const directory = await opendir(root)
  for await (const entry of directory) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`staged skills contain unsupported symlink: ${path}`)
    }
    if (entry.isDirectory()) {
      await unlockTree(path)
      await chmod(path, 0o700)
    } else if (entry.isFile()) {
      await chmod(path, 0o600)
    }
  }
  await chmod(root, 0o700)
}

async function measureTree(root) {
  let files = 0
  let directories = 0
  const directory = await opendir(root)
  for await (const entry of directory) {
    const path = join(root, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) throw new Error(`unexpected symlink: ${path}`)
    if (metadata.isDirectory()) {
      directories += 1
      const nested = await measureTree(path)
      files += nested.files
      directories += nested.directories
    } else if (metadata.isFile()) {
      files += 1
    }
  }
  return { files, directories }
}

async function copySkill(sourceRoot, stagingRoot, skillName) {
  const source = join(sourceRoot, skillName)
  const destination = join(stagingRoot, skillName)
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: sourcePath => shouldCopyPath(
      sourcePath,
      pathIsDirectory(sourcePath),
    ),
  })
}

function pathIsDirectory(path) {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

async function pruneBackups(backupRoot, keep = 2) {
  const entries = await readdir(backupRoot, { withFileTypes: true }).catch(() => [])
  const directories = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  for (const name of directories.slice(0, Math.max(0, directories.length - keep))) {
    const path = join(backupRoot, name)
    await unlockTree(path)
    await rm(path, { recursive: true, force: true })
  }
}

async function cleanupStaleStaging(parent) {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.skills-staging-')) continue
    const path = join(parent, entry.name)
    await unlockTree(path)
    await rm(path, { recursive: true, force: true })
  }
}

export async function importSkills(sourceRoot, destRoot, options = {}) {
  const source = resolve(sourceRoot)
  const destination = resolve(destRoot)
  if (source === destination || source.startsWith(`${destination}/`)
    || destination.startsWith(`${source}/`)) {
    throw new Error('source and destination skill roots must not overlap')
  }
  await assertNoSymlinks(source)
  const entries = await readdir(source, { withFileTypes: true })
  const skillNames = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => !EXCLUDED_DIRS.has(name))
    .filter(name => existsSync(join(source, name, 'SKILL.md')))
    .sort()
  if (skillNames.length === 0) throw new Error('skills source contains no top-level skills')

  const parent = dirname(destination)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await cleanupStaleStaging(parent)
  const staging = await mkdtemp(join(parent, '.skills-staging-'))
  try {
    for (const skillName of skillNames) {
      await copySkill(source, staging, skillName)
      const targetSkill = join(staging, skillName, 'SKILL.md')
      if (!existsSync(targetSkill)) throw new Error(`staged skill is incomplete: ${skillName}`)
    }
    await lockTree(staging)

    const stateRoot = resolve(options.stateRoot ?? DEFAULT_STATE_ROOT)
    const backupRoot = join(stateRoot, 'skills-backups')
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
    const backup = join(backupRoot, stamp)
    let movedCurrent = false
    if (existsSync(destination)) {
      await mkdir(backup, { recursive: true, mode: 0o700 })
      await unlockTree(destination)
      await rename(destination, join(backup, 'skills'))
      movedCurrent = true
    }
    try {
      await rename(staging, destination)
    } catch (error) {
      if (movedCurrent && !existsSync(destination)) {
        await rename(join(backup, 'skills'), destination)
      }
      if (existsSync(destination)) await lockTree(destination)
      throw error
    }
    await pruneBackups(backupRoot)
    const counts = await measureTree(destination)
    return {
      target: destination,
      skills: skillNames.length,
      files: counts.files,
      directories: counts.directories,
      commit: options.commit,
    }
  } finally {
    if (existsSync(staging)) {
      await unlockTree(staging)
      await rm(staging, { recursive: true, force: true })
    }
  }
}

export function ensureSkillsSource(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  const repoUrl = options.repoUrl ?? DEFAULT_REPO_URL
  const branch = options.branch ?? 'main'
  if (!existsSync(join(sourceRoot, '.git'))) {
    if (existsSync(sourceRoot)) {
      throw new Error(`source path exists but is not a git clone: ${sourceRoot}`)
    }
    runGit([
      'clone',
      '--depth=1',
      '--branch',
      branch,
      '--single-branch',
      repoUrl,
      sourceRoot,
    ])
  } else {
    const changes = runGit(['status', '--porcelain'], { cwd: sourceRoot })
    if (changes !== '') throw new Error('skills source clone has local changes')
    runGit(['pull', '--ff-only', 'origin', branch], { cwd: sourceRoot })
  }
  return {
    sourceRoot,
    commit: runGit(['rev-parse', 'HEAD'], { cwd: sourceRoot }),
  }
}

export async function syncSkills(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  const source = options.fetch === true
    ? ensureSkillsSource({
        repoUrl: options.repoUrl,
        sourceRoot,
        branch: options.branch,
      })
    : {
        sourceRoot,
        commit: existsSync(join(sourceRoot, '.git'))
          ? runGit(['rev-parse', 'HEAD'], { cwd: sourceRoot })
          : 'local-snapshot',
      }
  if (!existsSync(source.sourceRoot)) {
    throw new Error(`skills source does not exist: ${source.sourceRoot}; use --fetch or transfer it first`)
  }
  const result = await importSkills(source.sourceRoot, options.destRoot ?? DEFAULT_DEST_ROOT, {
    stateRoot: options.stateRoot,
    commit: source.commit,
  })
  return {
    source: source.sourceRoot,
    ...result,
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'usage: dsh-skills-sync [--fetch] [--repo-url URL] [--source DIR] [--dest DIR]\n',
    )
    return
  }
  const args = process.argv.slice(2)
  const valueAfter = name => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const result = await syncSkills({
    fetch: args.includes('--fetch'),
    repoUrl: valueAfter('--repo-url'),
    sourceRoot: valueAfter('--source'),
    destRoot: valueAfter('--dest'),
    stateRoot: process.env.STATE_ROOT,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exit(1)
  })
}
