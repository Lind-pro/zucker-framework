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
