import {Globber, DefaultGlobber} from './internal-globber'
import {GlobOptions} from './internal-glob-options'
import {HashFileOptions} from './internal-hash-file-options'
import {hashFiles as _hashFiles} from './internal-hash-files'

export {Globber, GlobOptions}

/**
 * Constructs a globber
 *
 * @param patterns  Patterns separated by newlines
 * @param options   Glob options
 */
export async function create(
  patterns: string,
  options?: GlobOptions
): Promise<Globber> {
  return await DefaultGlobber.create(patterns, options)
}

/**
 * Computes the sha256 hash of a glob
 *
 * @param patterns  Patterns separated by newlines
 * @param currentWorkspace  Workspace used when matching files
 * @param options   Hash file options (now supports roots, allowFilesOutsideWorkspace, exclude)
 * @param verbose   Enables verbose logging
 */
export async function hashFiles(
  patterns: string,
  currentWorkspace = '',
  options?: HashFileOptions,
  verbose: Boolean = false
): Promise<string> {
  let followSymbolicLinks = true
  if (options && typeof options.followSymbolicLinks === 'boolean') {
    followSymbolicLinks = options.followSymbolicLinks
  }
  // Pass all options through to _hashFiles, including new ones (roots, allowFilesOutsideWorkspace, exclude)
  const globber = await create(patterns, {followSymbolicLinks})
  // _hashFiles should be updated to use options.roots, options.allowFilesOutsideWorkspace, options.exclude
  return _hashFiles(globber, currentWorkspace, options, verbose)
}
