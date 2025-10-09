import * as crypto from 'crypto'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as stream from 'stream'
import * as util from 'util'
import * as path from 'path'
import {Globber} from './glob'
import {HashFileOptions} from './internal-hash-file-options'

function isInRoots(file: string, roots: string[]): boolean {
  return roots.some(root => file.startsWith(path.resolve(root) + path.sep))
}

function isExcluded(file: string, excludePatterns: string[]): boolean {
  const basename = path.basename(file)
  return excludePatterns.some(pattern => {
    if (pattern.startsWith('*.')) {
      // Match extension
      return basename.endsWith(pattern.slice(1))
    }
    // Exact match
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

  const result = crypto.createHash('sha256')
  let count = 0
  for await (const file of globber.globGenerator()) {
    writeDelegate(file)
    // Exclude matching patterns
    if (isExcluded(file, excludePatterns)) {
      writeDelegate(`Exclude '${file}' (pattern match).`)
      continue
    }
    // Check if in roots
    if (!isInRoots(file, roots)) {
      if (allowOutside) {
        writeDelegate(`Include '${file}' (outside roots, opt-in).`)
        // continue to hashing
      } else {
        writeDelegate(`Ignore '${file}' (outside roots, not opted-in).`)
        continue
      }
    }
    if (fs.statSync(file).isDirectory()) {
      writeDelegate(`Skip directory '${file}'.`)
      continue
    }
    const hash = crypto.createHash('sha256')
    const pipeline = util.promisify(stream.pipeline)
    await pipeline(fs.createReadStream(file), hash)
    result.write(hash.digest())
    count++
    if (!hasMatch) {
      hasMatch = true
    }
  }
  result.end()

  if (hasMatch) {
    writeDelegate(`Found ${count} files to hash.`)
    return result.digest('hex')
  } else {
    writeDelegate(`No matches found for glob`)
    return ''
  }
}
