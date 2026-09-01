import { describe, it, expect, beforeEach } from 'vitest';
import { DictDefineRepository, createDictDefine, createClassDictDefine } from './dict-define';
import { EnumDictRegistry } from './enum-dict';
import type { EnumDictItem } from './enum-dict';

describe('createDictDefine', () => {
  it('should create a DictDefine object', () => {
    const items: EnumDictItem[] = [{ value: 'a', text: 'A', ordinal: 0 }];
    const define = createDictDefine('d1', 'Dict One', 'A description', items);
    expect(define.id).toBe('d1');
    expect(define.alias).toBe('Dict One');
    expect(define.comments).toBe('A description');
    expect(define.items).toEqual(items);
  });
});

describe('createClassDictDefine', () => {
  it('should create a ClassDictDefine with field binding', () => {
    const items: EnumDictItem[] = [{ value: 'x', text: 'X', ordinal: 0 }];
    const define = createClassDictDefine('cd1', 'status', 'Status', 'status field', items);
    expect(define.field).toBe('status');
    expect(define.id).toBe('cd1');
  });
});

describe('DictDefineRepository', () => {
  let repo: DictDefineRepository;

  beforeEach(() => {
    repo = new DictDefineRepository();
    EnumDictRegistry.clear();
  });

  it('should add and retrieve a define', () => {
    const define = createDictDefine('d1', 'D1', '', []);
    repo.addDefine(define);
    expect(repo.getDefine('d1')).toBe(define);
  });

  it('should return undefined for unknown id', () => {
    expect(repo.getDefine('unknown')).toBeUndefined();
  });

  it('should fall back to EnumDictRegistry for getDefine', () => {
    EnumDictRegistry.register('auto', [{ value: 'v', text: 'V', ordinal: 0 }]);
    const define = repo.getDefine('auto');
    expect(define).toBeDefined();
    expect(define!.id).toBe('auto');
    expect(define!.items).toHaveLength(1);
  });

  it('should report has() for local and registry entries', () => {
    repo.addDefine(createDictDefine('local', 'L', '', []));
    EnumDictRegistry.register('remote', []);
    expect(repo.has('local')).toBe(true);
    expect(repo.has('remote')).toBe(true);
    expect(repo.has('neither')).toBe(false);
  });

  it('should merge local and registry entries in getAllDefine()', () => {
    repo.addDefine(createDictDefine('local', 'Local', '', []));
    EnumDictRegistry.register('remote', [{ value: 'r', text: 'R', ordinal: 0 }]);
    const all = repo.getAllDefine();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((d) => d.id === 'local')).toBe(true);
    expect(all.some((d) => d.id === 'remote')).toBe(true);
  });

  it('should not duplicate entries when local and registry have same id', () => {
    const items: EnumDictItem[] = [{ value: 'a', text: 'A', ordinal: 0 }];
    repo.addDefine(createDictDefine('dup', 'Local', '', items));
    EnumDictRegistry.register('dup', [{ value: 'b', text: 'B', ordinal: 0 }]);
    const all = repo.getAllDefine();
    const dups = all.filter((d) => d.id === 'dup');
    expect(dups).toHaveLength(1);
    // Local should take precedence
    expect(dups[0].alias).toBe('Local');
  });

  it('should parseAndRegister an enum', () => {
    enum Color { RED = 'red', BLUE = 'blue' }
    const define = repo.parseAndRegister('color', Color, { alias: 'Colors', comments: 'Color dict' });
    expect(define.id).toBe('color');
    expect(define.alias).toBe('Colors');
    expect(define.items.length).toBe(2);
    expect(repo.has('color')).toBe(true);
  });

  it('should parseAndRegister with defaults when no options', () => {
    enum Size { S = 's', M = 'm', L = 'l' }
    const define = repo.parseAndRegister('size', Size);
    expect(define.alias).toBe('size');
    expect(define.comments).toBe('');
    expect(define.items.length).toBe(3);
  });
});
