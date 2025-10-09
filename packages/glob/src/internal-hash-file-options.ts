/**
 * Options to control globbing behavior
 */
export interface HashFileOptions {
  /**
   * Indicates whether to follow symbolic links. Generally should set to false
   * when deleting files.
   *
   * @default true
   */
  followSymbolicLinks?: boolean

  /**
   * Array of allowed root directories for hashing files.
   * If not specified, defaults to [GITHUB_WORKSPACE].
   */
  roots?: string[]

  /**
   * Explicit opt-in to allow files outside the workspace.
   * If false or omitted, ONLY files in roots are hashed.
   * If true, files outside roots (e.g., temp, action path) are allowed.
   * Default: false
   */
  allowFilesOutsideWorkspace?: boolean

  /**
   * Array of glob patterns to exclude from hashing.
   */
  exclude?: string[]
}
