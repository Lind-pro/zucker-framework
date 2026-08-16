import { Injectable, Logger } from '@nestjs/common';
import { parseTemplate, NotFoundException, type ParseTemplateOptions } from '@zucker/core';
import {
  convertVariableValue,
  renderVariableMap,
  type NotifyTemplate,
  type NotifyChannel,
  type VariableDefinition,
} from './notifier.interface';

/**
 * Template properties for creating/updating templates.
 * Mirrors jetlinks TemplateProperties.
 */
export interface TemplateProperties {
  id: string;
  name: string;
  channel: NotifyChannel;
  provider?: string;
  content: string;
  variableDefinitions?: VariableDefinition[];
  configId?: string;
  description?: string;
}

/**
 * Template provider interface — mirrors jetlinks TemplateProvider.
 *
 * Different channel providers implement this to create channel-specific
 * template instances from configuration.
 */
export interface TemplateProvider {
  readonly channel: NotifyChannel;
  readonly provider: string;
  createTemplate(properties: TemplateProperties): NotifyTemplate;
  getTemplateConfigMetadata?(): Array<{
    key: string;
    name: string;
    type: string;
  }>;
}

/**
 * Template manager — mirrors jetlinks TemplateManager.
 *
 * Manages notification templates: CRUD, rendering with variable resolution,
 * and caching. Supports reload for dynamic configuration changes.
 */
@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);
  private readonly templates = new Map<string, NotifyTemplate>();

  /**
   * Render a template string with variables, applying variable definitions
   * for type conversion and validation.
   *
   * Mirrors jetlinks Template.render() + VariableDefinition.convertValue().
   */
  render(
    template: string,
    variables: Record<string, unknown>,
    variableDefinitions?: VariableDefinition[],
    options?: ParseTemplateOptions,
  ): string {
    // If variable definitions exist, convert values through them first
    let resolvedVars: Record<string, unknown> = variables;
    if (variableDefinitions?.length) {
      resolvedVars = { ...variables };
      for (const def of variableDefinitions) {
        const rawValue = resolvedVars[def.id];
        resolvedVars[def.id] = convertVariableValue(def, rawValue);
      }
    }
    // Pre-process template: strip HTML tags from variable names within ${...}
    // Aligned with jetlinks TemplateUtils.simpleRender() which uses Jsoup to parse
    // HTML-contaminated variable names before resolving them.
    const cleanedTemplate = template.replace(/\$\{([^}]+)}/g, (match, varName: string) => {
      if (varName.includes('<')) {
        const cleanName = varName.replace(/<[^>]*>/g, '').trim();
        return `\${${cleanName}}`;
      }
      return match;
    });
    return parseTemplate(cleanedTemplate, resolvedVars, options);
  }

  /**
   * Render a template by ID.
   * Resolves the template from the registry, then renders with variables.
   */
  renderById(
    templateId: string,
    variables: Record<string, unknown>,
    options?: ParseTemplateOptions,
  ): string {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new NotFoundException(`Template not found: ${templateId}`);
    }
    // Auto-enable HTML escaping for HTML-capable channels unless explicitly disabled
    const renderOptions: ParseTemplateOptions = {
      escapeHtml: this.isHtmlChannel(template.channel),
      ...options,
    };
    return this.render(template.content, variables, template.variableDefinitions, renderOptions);
  }

  /** Channels whose content may be rendered as HTML */
  private static readonly HTML_CHANNELS: ReadonlySet<string> = new Set([
    'EMAIL', 'WECHAT', 'DINGTALK',
  ]);

  private isHtmlChannel(channel: NotifyChannel): boolean {
    return TemplateService.HTML_CHANNELS.has(String(channel));
  }

  /**
   * Render a map of values through variable definitions without applying
   * template substitution. Useful for pre-processing context values before
   * sending to external APIs that handle their own template rendering.
   *
   * Mirrors jetlinks Template.renderMap().
   */
  renderMap(
    context: Record<string, unknown>,
    variableDefinitions: VariableDefinition[],
  ): Record<string, unknown> {
    return renderVariableMap(context, variableDefinitions);
  }

  /**
   * Create a template from properties and register it.
   * Mirrors jetlinks TemplateManager.createTemplate(NotifyType, TemplateProperties).
   *
   * If a TemplateProvider is registered for the channel+provider combination,
   * it is used to create a channel-specific template. Otherwise, a generic
   * template is created from the properties.
   */
  createTemplate(properties: TemplateProperties): NotifyTemplate {
    const template: NotifyTemplate = {
      id: properties.id,
      name: properties.name,
      channel: properties.channel,
      provider: properties.provider,
      content: properties.content,
      variableDefinitions: properties.variableDefinitions ?? [],
      configId: properties.configId,
      description: properties.description,
    };
    this.register(template);
    return template;
  }

  /**
   * Extract variable placeholders from a template string.
   * Strips HTML tags from variable names — aligns with jetlinks TemplateUtils.getVariables()
   * which handles HTML-contaminated variable names via Jsoup.parse(varName).text().
   */
  extractVariables(template: string): string[] {
    const matches = template.matchAll(/\$\{([^}]+)}/g);
    const vars = new Set<string>();
    for (const m of matches) {
      let varName = m[1];
      // Strip HTML tags if present — aligned with jetlinks TemplateUtils behavior
      if (varName.includes('<')) {
        varName = varName.replace(/<[^>]*>/g, '').trim();
      }
      if (varName) {
        vars.add(varName);
      }
    }
    return [...vars];
  }

  /**
   * Register a template. Mirrors jetlinks TemplateManager pattern.
   */
  register(template: NotifyTemplate): void {
    this.templates.set(template.id, template);
    this.logger.log(`Template registered: ${template.id} (${template.name})`);
  }

  /**
   * Get a template by ID.
   */
  getTemplate(id: string): NotifyTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Get a template by type and ID.
   * Mirrors jetlinks TemplateManager.getTemplate(NotifyType, String).
   */
  getTemplateByChannel(channel: NotifyChannel, id: string): NotifyTemplate | undefined {
    const template = this.templates.get(id);
    if (template && template.channel === channel) {
      return template;
    }
    return undefined;
  }

  /**
   * Remove a template.
   */
  remove(id: string): boolean {
    const removed = this.templates.delete(id);
    if (removed) {
      this.logger.log(`Template removed: ${id}`);
    }
    return removed;
  }

  /**
   * Reload a template (clear cache entry, forcing re-fetch on next access).
   * Mirrors jetlinks TemplateManager.reload(String).
   */
  reload(templateId: string): void {
    this.templates.delete(templateId);
    this.logger.log(`Template cache cleared: ${templateId}`);
  }

  /**
   * List all registered templates, optionally filtered by channel.
   */
  listTemplates(channel?: NotifyChannel): NotifyTemplate[] {
    const all = [...this.templates.values()];
    if (channel) {
      return all.filter((t) => t.channel === channel);
    }
    return all;
  }
}
