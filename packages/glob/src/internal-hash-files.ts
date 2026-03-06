import * as crypto from 'crypto'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as stream from 'stream'
import * as util from 'util'
import * as path from 'path'
import minimatch from 'minimatch'
import {Globber} from './glob.js'
import {HashFileOptions} from './internal-hash-file-options.js'

type IMinimatchOptions = minimatch.IOptions
const {Minimatch} = minimatch

/**
 * Symlink Protection: Checks if the realpath of file is inside any of the realpaths of roots.
 * Prevents files escaping via symlink traversal.
 */
function isInResolvedRoots(
  resolvedFile: string,
  resolvedRoots: string[]
): boolean {
  // Allow exact root equality, and root directory containment
  return resolvedRoots.some(
    root => resolvedFile === root || resolvedFile.startsWith(root + path.sep)
  )
}

function normalizeForMatch(p: string): string {
  // minimatch expects "/"-style separators
  return p.split(path.sep).join('/')
}

function mm(pat: string, target: string, matchBase: boolean): boolean {
  return new Minimatch(pat, {dot: true, matchBase} as IMinimatchOptions).match(
    target
  )
}

function isExcluded(
  file: string,
  excludePatterns: string[],
  githubWorkspace: string
): boolean {
  if (!excludePatterns || excludePatterns.length === 0) return false

  const abs = path.resolve(file)
  const absNorm = normalizeForMatch(abs)

  const rel = path.relative(githubWorkspace, abs)
  const relNorm = normalizeForMatch(rel)

  return excludePatterns.some(pattern => {
    const pat = normalizeForMatch(pattern)

    // If the pattern is basename-only (no "/"), allow matchBase so "*.log" works anywhere.
    // Otherwise do path-based matching for patterns like "**/node_modules/**".
    const isBasenamePattern = !pat.includes('/')

    return mm(pat, absNorm, false) || mm(pat, relNorm, isBasenamePattern)
  })
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

  // Symlink Protection: resolve all roots up front
  let resolvedRoots: string[] = []
  try {
    resolvedRoots = roots.map(root => fs.realpathSync(root))
  } catch (err) {
    core.warning(`Could not check workspace location: ${err}`)
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
    if (isExcluded(resolvedFile, excludePatterns, githubWorkspace)) {
      writeDelegate(`Exclude '${file}' (exclude pattern match).`)
      continue
    }

    // Check if in resolved roots
    if (!isInResolvedRoots(resolvedFile, resolvedRoots)) {
      outsideRootFiles.push(file)
      if (allowOutside) {
        writeDelegate(
          `Including '${file}' since it is outside the allowed workspace root(s) and 'allowFilesOutsideWorkspace' is enabled.`
        )
      } else {
        writeDelegate(
          `Skip '${file}' since it is not under allowed workspace root(s).`
        )
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

  // Warn if any files outside root found without opt-in
  if (!allowOutside && outsideRootFiles.length > 0) {
    writeDelegate(
      `Some files are outside your workspace:\n${outsideRootFiles
        .map(f => `- ${f}`)
        .join(
          '\n'
        )}\nTo include them, set 'allowFilesOutsideWorkspace: true' in your options.`
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
