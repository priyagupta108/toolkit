import * as crypto from 'crypto'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as stream from 'stream'
import * as util from 'util'
import * as path from 'path'
import minimatch from 'minimatch'
import {Globber} from './glob.js'
import {HashFileOptions} from './internal-hash-file-options.js'

type IMinimatch = minimatch.IMinimatch
type IMinimatchOptions = minimatch.IOptions
const {Minimatch} = minimatch

const IS_WINDOWS = process.platform === 'win32'

const MAX_WARNED_FILES = 10

type ExcludeMatcher = {
  absolutePathMatcher: IMinimatch
  workspaceRelativeMatcher: IMinimatch
}

/**
 * Symlink Protection: Checks if the realpath of file is inside any of the realpaths of roots.
 * Prevents files escaping via symlink traversal.
 *
 * Uses path.relative() for containment check to correctly handle:
 * - Filesystem roots (e.g. '/' on POSIX, 'C:\' on Windows)
 * - Case-insensitive filesystems on Windows
 * - Roots that may or may not end with a path separator
 */
function isInResolvedRoots(
  resolvedFile: string,
  resolvedRoots: string[]
): boolean {
  return resolvedRoots.some(root => {
    if (resolvedFile === root) return true
    const normalizedFile = IS_WINDOWS
      ? resolvedFile.toLowerCase()
      : resolvedFile
    const normalizedRoot = IS_WINDOWS ? root.toLowerCase() : root
    const rel = path.relative(normalizedRoot, normalizedFile)
    return rel.length > 0 && !rel.startsWith('..')
  })
}

function normalizeForMatch(p: string): string {
  // minimatch expects "/"-style separators
  return p.split(path.sep).join('/')
}

function buildExcludeMatchers(
  excludePatterns: string[],
  minimatchOptions: IMinimatchOptions
): ExcludeMatcher[] {
  if (!excludePatterns || excludePatterns.length === 0) return []

  return excludePatterns.map(pattern => {
    const normalizedPattern = normalizeForMatch(pattern)

    // If the pattern is basename-only (no "/"), allow matchBase so "*.log" works anywhere.
    // Otherwise do path-based matching for patterns like "**/node_modules/**".
    const isBasenamePattern = !normalizedPattern.includes('/')

    return {
      absolutePathMatcher: new Minimatch(normalizedPattern, {
        ...minimatchOptions,
        matchBase: false
      } as IMinimatchOptions),
      workspaceRelativeMatcher: new Minimatch(normalizedPattern, {
        ...minimatchOptions,
        matchBase: isBasenamePattern
      } as IMinimatchOptions)
    }
  })
}

function isExcluded(
  resolvedFile: string,
  excludeMatchers: ExcludeMatcher[],
  githubWorkspace: string
): boolean {
  if (!excludeMatchers || excludeMatchers.length === 0) return false

  const absolutePath = path.resolve(resolvedFile)
  const absolutePathForMatch = normalizeForMatch(absolutePath)

  const workspaceRelativePath = path.relative(githubWorkspace, absolutePath)
  const workspaceRelativePathForMatch = normalizeForMatch(workspaceRelativePath)

  return excludeMatchers.some(
    m =>
      m.absolutePathMatcher.match(absolutePathForMatch) ||
      m.workspaceRelativeMatcher.match(workspaceRelativePathForMatch)
  )
}

export async function hashFiles(
  globber: Globber,
  currentWorkspace: string,
  options?: HashFileOptions,
  verbose: Boolean = false
): Promise<string> {
  const writeDelegate = verbose ? core.info : core.debug
  let hasMatch = false

  // Determine roots for inclusion (default to currentWorkspace)
  const githubWorkspace = currentWorkspace
    ? currentWorkspace
    : (process.env['GITHUB_WORKSPACE'] ?? process.cwd())
  const roots = options?.roots ?? [githubWorkspace]
  const allowOutside = options?.allowFilesOutsideWorkspace ?? false
  const excludePatterns: string[] = options?.exclude ?? []

  const minimatchOptions: IMinimatchOptions = {
    dot: true,
    nobrace: true,
    nocase: IS_WINDOWS,
    nocomment: true,
    noext: true,
    nonegate: true
  }
  
  const excludeMatchers = buildExcludeMatchers(excludePatterns, minimatchOptions)

  // Symlink Protection: resolve all roots up front, but don't fail the entire operation
  // if one root is invalid. Warn for invalid roots and proceed with the valid ones.
  const resolvedRoots: string[] = []
  for (const root of roots) {
    try {
      resolvedRoots.push(fs.realpathSync(root))
    } catch (err) {
      core.warning(`Could not resolve root '${root}': ${err}`)
    }
  }

  if (resolvedRoots.length === 0) {
    core.warning(
      `Could not resolve any allowed root(s); no files will be considered for hashing.`
    )
    return ''
  }

  const outsideRootFiles: string[] = []
  const result = crypto.createHash('sha256')
  let count = 0

  for await (const file of globber.globGenerator()) {
    writeDelegate(file)

    // Symlink Protection: resolve real path of the file (use this for exclude + hashing)
    let resolvedFile: string
    try {
      resolvedFile = fs.realpathSync(file)
    } catch (err) {
      core.warning(
        `Could not read "${file}". Please check symlinks and file access. Details: ${err}`
      )
      continue // skip if unable to resolve symlink
    }

    // Exclude matching patterns (apply to resolved path for symlink-safety)
    if (isExcluded(resolvedFile, excludeMatchers, githubWorkspace)) {
      writeDelegate(`Exclude '${file}' (exclude pattern match).`)
      continue
    }

    // Check if in resolved roots
    if (!isInResolvedRoots(resolvedFile, resolvedRoots)) {
      outsideRootFiles.push(file)
      if (allowOutside) {
        writeDelegate(
          `Including '${file}' since it is outside the allowed root(s) and 'allowFilesOutsideWorkspace' is enabled.`
        )
      } else {
        writeDelegate(`Skip '${file}' since it is not under allowed root(s).`)
        continue
      }
    }

    if (fs.statSync(resolvedFile).isDirectory()) {
      writeDelegate(`Skip directory '${file}'.`)
      continue
    }

    const hash = crypto.createHash('sha256')
    const pipeline = util.promisify(stream.pipeline)
    await pipeline(fs.createReadStream(resolvedFile), hash)
    result.write(hash.digest())
    count++
    hasMatch = true
  }
  result.end()

  // Warn if any files outside root were found without opt-in.
  if (!allowOutside && outsideRootFiles.length > 0) {
    const shown = outsideRootFiles.slice(0, MAX_WARNED_FILES)
    const remaining = outsideRootFiles.length - shown.length
    const fileList = shown.map(f => `- ${f}`).join('\n')
    const suffix =
      remaining > 0
        ? `\n  ...and ${remaining} more file(s). Enable debug logging to see all.`
        : ''
    core.warning(
      `Some matched files are outside the allowed root(s) and were skipped:\n${fileList}${suffix}\n` +
        `To include them, set 'allowFilesOutsideWorkspace: true' in your options.`
    )
  }

  if (hasMatch) {
    writeDelegate(`Found ${count} files to hash.`)
    return result.digest('hex')
  } else {
    writeDelegate(`No matches found for glob`)
    return ''
  }
}
