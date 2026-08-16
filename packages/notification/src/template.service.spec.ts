/* eslint-disable no-template-curly-in-string -- placeholders are test fixtures */
import { describe, it, expect, beforeEach } from 'vitest';
import { TemplateService } from './template.service';
import type { VariableDefinition, NotifyChannel } from './notifier.interface';

describe('TemplateService', () => {
  let service: TemplateService;

  beforeEach(() => {
    service = new TemplateService();
  });

  describe('render', () => {
    it('should render a template with simple variables', () => {
      const result = service.render('Hello ${name}!', { name: 'World' });
      expect(result).toBe('Hello World!');
    });

    it('should render a template with multiple variables', () => {
      const result = service.render('${greeting}, ${name}!', {
        greeting: 'Hi',
        name: 'Alice',
      });
      expect(result).toBe('Hi, Alice!');
    });

    it('should apply variable definitions for type conversion', () => {
      const defs: VariableDefinition[] = [
        { id: 'price', name: 'Price', type: 'number', format: '%.2f' },
      ];
      const result = service.render('Total: ${price}', { price: 9.5 }, defs);
      expect(result).toBe('Total: 9.50');
    });

    it('should use default value from variable definition when value is missing', () => {
      const defs: VariableDefinition[] = [
        { id: 'status', name: 'Status', defaultValue: 'active' },
      ];
      const result = service.render('Status: ${status}', {}, defs);
      expect(result).toBe('Status: active');
    });

    it('should render empty string for undefined variables without definitions', () => {
      const result = service.render('Hello ${missing}!', {});
      expect(result).toBe('Hello !');
    });
  });

  describe('renderById', () => {
    it('should render a registered template by ID', () => {
      service.register({
        id: 'welcome',
        name: 'Welcome',
        channel: 'SMS' as NotifyChannel,
        content: 'Welcome ${user}!',
        variableDefinitions: [],
      });
      const result = service.renderById('welcome', { user: 'Bob' });
      expect(result).toBe('Welcome Bob!');
    });

    it('should throw NotFoundException for unknown template ID', () => {
      expect(() => service.renderById('nonexistent', {})).toThrow(
        'Template not found: nonexistent',
      );
    });

    it('should enable HTML escaping for EMAIL channel templates', () => {
      service.register({
        id: 'email-tpl',
        name: 'Email',
        channel: 'EMAIL' as NotifyChannel,
        content: 'Hello ${name}',
        variableDefinitions: [],
      });
      const result = service.renderById('email-tpl', { name: '<script>alert(1)</script>' });
      expect(result).toContain('&lt;script&gt;');
      expect(result).not.toContain('<script>');
    });
  });

  describe('register', () => {
    it('should register and retrieve a template', () => {
      const template = {
        id: 't1',
        name: 'Test',
        channel: 'SMS' as NotifyChannel,
        content: 'Hello',
        variableDefinitions: [],
      };
      service.register(template);
      expect(service.getTemplate('t1')).toEqual(template);
    });

    it('should overwrite existing template with same ID', () => {
      service.register({
        id: 't1',
        name: 'V1',
        channel: 'SMS' as NotifyChannel,
        content: 'v1',
        variableDefinitions: [],
      });
      service.register({
        id: 't1',
        name: 'V2',
        channel: 'EMAIL' as NotifyChannel,
        content: 'v2',
        variableDefinitions: [],
      });
      expect(service.getTemplate('t1')?.name).toBe('V2');
    });
  });

  describe('createTemplate', () => {
    it('should create and register a template from properties', () => {
      const tpl = service.createTemplate({
        id: 'ct1',
        name: 'Created',
        channel: 'WEBHOOK' as NotifyChannel,
        content: 'body: ${data}',
      });
      expect(tpl.id).toBe('ct1');
      expect(service.getTemplate('ct1')).toBeDefined();
    });
  });

  describe('extractVariables', () => {
    it('should extract variable names from template string', () => {
      const vars = service.extractVariables('Hello ${name}, your order ${order.id} is ready');
      expect(vars).toContain('name');
      expect(vars).toContain('order.id');
    });

    it('should return unique variable names', () => {
      const vars = service.extractVariables('${x} and ${x} again');
      expect(vars).toEqual(['x']);
    });
  });

  describe('listTemplates', () => {
    it('should list all templates', () => {
      service.register({ id: 'a', name: 'A', channel: 'SMS' as NotifyChannel, content: '', variableDefinitions: [] });
      service.register({ id: 'b', name: 'B', channel: 'EMAIL' as NotifyChannel, content: '', variableDefinitions: [] });
      expect(service.listTemplates()).toHaveLength(2);
    });

    it('should filter templates by channel', () => {
      service.register({ id: 'a', name: 'A', channel: 'SMS' as NotifyChannel, content: '', variableDefinitions: [] });
      service.register({ id: 'b', name: 'B', channel: 'EMAIL' as NotifyChannel, content: '', variableDefinitions: [] });
      const smsOnly = service.listTemplates('SMS' as NotifyChannel);
      expect(smsOnly).toHaveLength(1);
      expect(smsOnly[0].id).toBe('a');
    });
  });

  describe('remove and reload', () => {
    it('should remove a template', () => {
      service.register({ id: 'r1', name: 'R1', channel: 'SMS' as NotifyChannel, content: '', variableDefinitions: [] });
      expect(service.remove('r1')).toBe(true);
      expect(service.getTemplate('r1')).toBeUndefined();
    });

    it('should return false when removing non-existent template', () => {
      expect(service.remove('nope')).toBe(false);
    });

    it('should clear cache on reload', () => {
      service.register({ id: 'rl1', name: 'RL1', channel: 'SMS' as NotifyChannel, content: '', variableDefinitions: [] });
      service.reload('rl1');
      expect(service.getTemplate('rl1')).toBeUndefined();
    });
  });
});
