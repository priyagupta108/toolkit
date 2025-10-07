/**
 * Options to control globbing behavior and secure file access
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
   * Additional trusted root directories for file access.
   * Example: ['/tmp', '/mnt/data']
   */
  allowedRoots?: string[]

  /**
   * Optionally include common CI/CD temporary directories (e.g. RUNNER_TEMP) as trusted roots.
   */
  includeTempDirs?: boolean

  /**
   * Explicit opt-in for advanced access outside default and allowed roots.
   * Must be enabled intentionally.
   */
  allowAdvancedAccess?: boolean

  /**
   * Pattern-based allowlist for granular file selection within allowed roots.
   * Example: ['*.log', '*.txt']
   */
  patterns?: string[]
}
