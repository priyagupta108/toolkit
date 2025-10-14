import * as crypto from 'crypto'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as stream from 'stream'
import * as util from 'util'
import * as path from 'path'
import {Globber} from './glob'
import {HashFileOptions} from './internal-hash-file-options'

/**
 * Symlink Protection: Checks if the realpath of file is inside any of the realpaths of roots.
 * Prevents files escaping via symlink traversal.
 */
function isInResolvedRoots(
  resolvedFile: string,
  resolvedRoots: string[]
): boolean {
  // Ensure normalized path comparison with trailing separator
  return resolvedRoots.some(root => resolvedFile.startsWith(root + path.sep))
}

function isExcluded(file: string, excludePatterns: string[]): boolean {
  const basename = path.basename(file)
  return excludePatterns.some(pattern => {
    if (pattern.startsWith('*.')) {
      return basename.endsWith(pattern.slice(1))
    }
    return basename === pattern
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
    : process.env['GITHUB_WORKSPACE'] ?? process.cwd()
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
    // Exclude matching patterns
    if (isExcluded(file, excludePatterns)) {
      writeDelegate(`Exclude '${file}' (pattern match).`)
      continue
    }

    // Symlink Protection: resolve real path of the file
    let resolvedFile: string
    try {
      resolvedFile = fs.realpathSync(file)
    } catch (err) {
      core.warning(
        `Could not read "${file}". Please check symlinks and file access. Details: ${err}`
      )
      continue // skip if unable to resolve symlink
    }

    // Check if in resolved roots
    if (!isInResolvedRoots(resolvedFile, resolvedRoots)) {
      outsideRootFiles.push(file)
      if (allowOutside) {
        writeDelegate(
          `Including '${file}' since it is outside the allowed workspace root(s) and 'allowFilesOutsideWorkspace' is enabled.`
        )
        // continue to hashing
      } else {
        writeDelegate(
          `Ignore '${file}' since it is not under allowed workspace root(s).`
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

  // fail if any files outside root found without opt-in
  if (!allowOutside && outsideRootFiles.length > 0) {
    throw new Error(
      `Some files are outside your workspace:\n` +
        outsideRootFiles.map(f => `- ${f}`).join('\n') +
        `\nTo include them, set 'allowFilesOutsideWorkspace: true' in your options.`
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
