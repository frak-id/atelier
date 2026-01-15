/**
 * Project type definitions
 */

export interface Project {
  /** Unique project identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Git repository URL */
  gitUrl: string;
  /** Default branch to clone */
  defaultBranch: string;
  /** Whether project has secrets configured */
  hasSecrets: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
}

export interface CreateProjectOptions {
  /** Human-readable name */
  name: string;
  /** Git repository URL */
  gitUrl: string;
  /** Default branch (default: main) */
  defaultBranch?: string;
}

export interface UpdateProjectOptions {
  /** Human-readable name */
  name?: string;
  /** Git repository URL */
  gitUrl?: string;
  /** Default branch */
  defaultBranch?: string;
}
