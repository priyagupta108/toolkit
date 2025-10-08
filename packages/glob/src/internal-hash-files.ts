import * as crypto from 'crypto'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as stream from 'stream'
import * as util from 'util'
import * as path from 'path'
import {Globber} from './glob'

export async function hashFiles(
  globber: Globber,
  currentWorkspace: string,
  verbose: Boolean = false
): Promise<string> {
  const writeDelegate = verbose ? core.info : core.debug
  let hasMatch = false
  const githubWorkspace = currentWorkspace
    ? currentWorkspace
    : process.env['GITHUB_WORKSPACE'] ?? process.cwd()

  // NEW: Support GITHUB_ACTION_PATH as an allowed root
  const allowedRoots: string[] = [githubWorkspace]
  if (process.env['GITHUB_ACTION_PATH']) {
    allowedRoots.push(path.resolve(process.env['GITHUB_ACTION_PATH']))
  }

  const result = crypto.createHash('sha256')
  let count = 0
  for await (const file of globber.globGenerator()) {
    writeDelegate(file)
    const filePath = path.resolve(file)
    const isAllowed = allowedRoots.some(root =>
      filePath.startsWith(root + path.sep)
    )
    if (!isAllowed) {
      writeDelegate(`Ignore '${file}' since it is not under an allowed root.`)
      continue
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
