import * as crypto from 'crypto'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as stream from 'stream'
import * as util from 'util'
import * as path from 'path'
import {Globber} from './glob'
import {HashFileOptions} from './internal-hash-file-options'

export async function hashFiles(
  globber: Globber,
  currentWorkspace: string,
  options?: HashFileOptions,
  verbose: Boolean = false
): Promise<string> {
  const writeDelegate = verbose ? core.info : core.debug
  let hasMatch = false

  // Default allowed roots
  const githubWorkspace =
    (currentWorkspace || process.env['GITHUB_WORKSPACE']) ?? process.cwd()
  const githubActionPath = process.env['GITHUB_ACTION_PATH']
  let allowedRoots = [githubWorkspace]
  if (githubActionPath) allowedRoots.push(githubActionPath)

  // Add configurable roots
  if (options?.allowedRoots && Array.isArray(options.allowedRoots)) {
    allowedRoots = allowedRoots.concat(options.allowedRoots)
  }

  // Optionally include temp dirs
  if (options?.includeTempDirs && process.env['RUNNER_TEMP']) {
    allowedRoots.push(process.env['RUNNER_TEMP'])
  }

  allowedRoots = allowedRoots.map(r => path.resolve(r))
  const advancedOptIn = !!options?.allowAdvancedAccess

  // Pattern-based allowlist
  const patterns = options?.patterns ?? []

  const result = crypto.createHash('sha256')
  let count = 0
  for await (const file of globber.globGenerator()) {
    writeDelegate(`[DEBUG] Considering file: ${file}`)
    const filePath = path.resolve(file)
    const isAllowedRoot = allowedRoots.some(root => filePath.startsWith(root))
    const matchesPattern =
      patterns.length === 0 || patterns.some(pat => filePath.includes(pat))

    if ((!isAllowedRoot || !matchesPattern) && !advancedOptIn) {
      writeDelegate(
        `[AUDIT] Ignored file: '${file}' outside allowed roots or patterns`
      )
      continue
    }

    if ((!isAllowedRoot || !matchesPattern) && advancedOptIn) {
      writeDelegate(
        `[AUDIT] Advanced access: '${file}' outside default roots or patterns`
      )
      // Optionally, save for audit
    }

    if (fs.statSync(file).isDirectory()) {
      writeDelegate(`[DEBUG] Skipped directory: '${file}'`)
      continue
    }

    // Hashing logic
    const hash = crypto.createHash('sha256')
    const pipeline = util.promisify(stream.pipeline)
    await pipeline(fs.createReadStream(file), hash)
    result.write(hash.digest())
    count++
    hasMatch = true
  }
  result.end()

  writeDelegate(`Found ${count} files to hash.`)
  return hasMatch ? result.digest('hex') : ''
}
