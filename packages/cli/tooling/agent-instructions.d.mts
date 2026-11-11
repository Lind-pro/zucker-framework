export interface AgentInstructionPolicy {
  skillsDirectory: string;
  documents: readonly string[];
  rootDocument: string;
  compatibilityLinks: readonly {
    path: string;
    target?: string;
    optional?: boolean;
  }[];
  skillAliasDirectories: readonly string[];
  allowSkillReferenceAliases?: boolean;
  checkGit?: boolean;
}

export interface AgentInstructionAudit {
  errors: string[];
  skills: number;
  aliases: number;
}

/** Read the selected local instruction documents and optionally inspect Git ignore visibility. */
export declare function auditAgentInstructions(
  repository: string,
  policy: AgentInstructionPolicy,
): AgentInstructionAudit;


export interface ConsumerAgentInstructionOptions {
  /** Create CLAUDE.md as a relative AGENTS.md alias when absent. Defaults to true. */
  claudeLink?: boolean;
}

export interface ConsumerAgentInstructionInstallation {
  agents: 'created' | 'preserved' | 'skipped';
  claude: 'created' | 'preserved' | 'skipped';
  /** Nonfatal preserved-policy conflicts or unavailable optional symlink support. */
  warnings: string[];
}

/**
 * Install supplied standalone instructions in an existing consumer directory.
 * Never overwrites existing entries or logs/reads environment values. Existing
 * CLAUDE-only instructions are preserved without adding a competing AGENTS.md.
 */
export declare function installConsumerAgentInstructions(
  repository: string,
  source: string,
  options?: ConsumerAgentInstructionOptions,
): ConsumerAgentInstructionInstallation;

/** `{ '<skill>/<relative path>': base64 }`, `.md`/`.json` only. */
export type ConsumerSkillAssets = Record<string, string>;

export declare const CONSUMER_SKILL_LIMITS: Readonly<{ maxFiles: number; maxFileBytes: number }>;

export interface ConsumerSkillFile {
  name: string;
  path: string;
  relative: string[];
  text: string;
}

/** Throws on an invalid path, encoding, size, count or a skill without SKILL.md. */
export declare function validateConsumerSkills(skills: unknown): ConsumerSkillFile[];

export interface ConsumerSkillInstallation {
  /** Project-relative files written by this call. */
  created: string[];
  /** Project-relative files that already existed and were left untouched. */
  preserved: string[];
  links: { created: string[]; preserved: string[] };
  /** Nonfatal skips (non-local directories, unsupported symlinks). */
  warnings: string[];
}

/**
 * Writes `.agents/skills/<name>/...` with exclusive creation and adds `.claude/skills/<name>` relative
 * links. Never overwrites, never follows a symbolic link out of the project.
 */
export declare function installConsumerAgentSkills(
  repository: string,
  skills: ConsumerSkillAssets,
): ConsumerSkillInstallation;
