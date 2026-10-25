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
