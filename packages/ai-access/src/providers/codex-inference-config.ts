/**
 * Codex `--config` overrides for a restricted, tool-free inference session.
 *
 * Every Codex entry point (exec, app-server, socket host) uses this one list so the
 * sandbox cannot drift between them. Current Codex CLIs read project instructions
 * (AGENTS.md) from the working directory while creating a session; a denied workspace
 * then fails session creation with "Permission denied". `project_doc_max_bytes=0`
 * disables that load, so the workspace can stay unreadable for the model. Codex reads
 * `--output-schema` in its own process, so a schema file needs no workspace access.
 */
export const CODEX_INFERENCE_CONFIG_OVERRIDES: readonly string[] = Object.freeze([
  'approval_policy="never"',
  'allow_login_shell=false',
  'shell_environment_policy.inherit="none"',
  'default_permissions="subscription_inference"',
  'permissions.subscription_inference.filesystem={":minimal"="read",":workspace_roots"={"."="deny"}}',
  'permissions.subscription_inference.network.enabled=false',
  'features.hooks=false',
  'features.apps=false',
  'features.plugins=false',
  'features.memories=false',
  'memories.use_memories=false',
  'memories.generate_memories=false',
  'features.multi_agent=false',
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.code_mode.enabled=false',
  'web_search="disabled"',
  'tools.web_search=false',
  'apps._default.enabled=false',
  'project_doc_max_bytes=0',
  // Built-in tools that current CLIs still offer once shell, web and apps are off.
  // Each call re-sends the whole context, so one runaway turn costs hundreds of
  // thousands of input tokens. Tools that cannot be disabled here are stopped by the
  // tool-activity guard in each transport.
  'features.goals=false',
  'features.sleep_tool=false',
  'features.image_generation=false',
  'features.computer_use=false',
  'features.browser_use=false',
  'features.browser_use_external=false',
  'features.in_app_browser=false',
  'features.tool_suggest=false',
  'features.skill_search=false',
  'features.multi_agent_v2=false',
  'mcp_servers={}',
]);

/** The overrides as `--config <value>` argument pairs. */
export function codexInferenceConfigArgs(): string[] {
  return CODEX_INFERENCE_CONFIG_OVERRIDES.flatMap((override) => ['--config', override]);
}
