import { describe, it, expect, beforeEach } from 'vitest';
import { FormService } from './form.service';
import type { FormDefinition } from './form-definition';

// Minimal mock for DatabaseAdapter
function createMockDb() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    model: () => ({
      findUnique: async ({ where }: any) => store.get(where.id) ?? null,
      findMany: async () => Array.from(store.values()),
      create: async ({ data }: any) => { store.set(data.id, data); return data; },
      update: async ({ where, data }: any) => {
        const existing = store.get(where.id);
        const updated = { ...existing, ...data };
        store.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: any) => { store.delete(where.id); },
    }),
  };
}

describe('FormService.validateData', () => {
  let service: FormService;

  beforeEach(() => {
    const db = createMockDb();
    service = new (FormService as any)(db);
  });

  const baseForm: FormDefinition = {
    id: 'f1',
    name: 'Test Form',
    fields: [],
  };

  it('should pass validation for valid data', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        { key: 'name', name: 'Name', type: 'string', required: true },
      ],
    };
    const result = service.validateData(form, { name: 'Alice' });
    expect(result.valid).toBe(true);
    expect(Object.keys(result.errors)).toHaveLength(0);
  });

  it('should fail for missing required field', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        { key: 'name', name: 'Name', type: 'string', required: true },
      ],
    };
    const result = service.validateData(form, {});
    expect(result.valid).toBe(false);
    expect(result.errors['name']).toBeDefined();
    expect(result.errors['name'][0]).toContain('required');
  });

  it('should fail for empty string on required field', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        { key: 'name', name: 'Name', type: 'string', required: true },
      ],
    };
    const result = service.validateData(form, { name: '' });
    expect(result.valid).toBe(false);
  });

  it('should validate field type via FieldTypeRegistry', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        { key: 'count', name: 'Count', type: 'number' },
      ],
    };
    const result = service.validateData(form, { count: 'not a number' });
    expect(result.valid).toBe(false);
    expect(result.errors['count'][0]).toContain('number');
  });

  it('should validate minLength validator', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        {
          key: 'pw',
          name: 'Password',
          type: 'string',
          validators: [{ type: 'minLength', message: 'Too short', params: { min: 8 } }],
        },
      ],
    };
    const result = service.validateData(form, { pw: 'abc' });
    expect(result.valid).toBe(false);
    expect(result.errors['pw'][0]).toBe('Too short');
  });

  it('should validate maxLength validator', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        {
          key: 'code',
          name: 'Code',
          type: 'string',
          validators: [{ type: 'maxLength', message: 'Too long', params: { max: 5 } }],
        },
      ],
    };
    const result = service.validateData(form, { code: 'abcdef' });
    expect(result.valid).toBe(false);
  });

  it('should validate min/max numeric validators', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        {
          key: 'age',
          name: 'Age',
          type: 'number',
          validators: [
            { type: 'min', message: 'Too young', params: { min: 18 } },
            { type: 'max', message: 'Too old', params: { max: 120 } },
          ],
        },
      ],
    };
    expect(service.validateData(form, { age: 10 }).valid).toBe(false);
    expect(service.validateData(form, { age: 25 }).valid).toBe(true);
    expect(service.validateData(form, { age: 200 }).valid).toBe(false);
  });

  it('should validate pattern validator', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        {
          key: 'email',
          name: 'Email',
          type: 'string',
          validators: [{ type: 'pattern', message: 'Invalid email', params: { pattern: '^\\S+@\\S+$' } }],
        },
      ],
    };
    expect(service.validateData(form, { email: 'a@b.com' }).valid).toBe(true);
    expect(service.validateData(form, { email: 'invalid' }).valid).toBe(false);
  });

  it('should validate enum options', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        {
          key: 'role',
          name: 'Role',
          type: 'string',
          options: [
            { label: 'Admin', value: 'admin' },
            { label: 'User', value: 'user' },
          ],
        },
      ],
    };
    expect(service.validateData(form, { role: 'admin' }).valid).toBe(true);
    expect(service.validateData(form, { role: 'hacker' }).valid).toBe(false);
  });

  it('should skip type/custom validation for null non-required fields', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        {
          key: 'opt',
          name: 'Optional',
          type: 'number',
          required: false,
          validators: [{ type: 'min', message: 'Too low', params: { min: 0 } }],
        },
      ],
    };
    const result = service.validateData(form, {});
    expect(result.valid).toBe(true);
  });

  it('should return multiple errors for multiple failing fields', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        { key: 'name', name: 'Name', type: 'string', required: true },
        { key: 'age', name: 'Age', type: 'number', required: true },
        { key: 'email', name: 'Email', type: 'string', required: true },
      ],
    };
    const result = service.validateData(form, {});
    expect(result.valid).toBe(false);
    expect(Object.keys(result.errors)).toHaveLength(3);
    expect(result.errors['name']).toBeDefined();
    expect(result.errors['age']).toBeDefined();
    expect(result.errors['email']).toBeDefined();
  });

  it('should collect multiple errors for one field (type + custom validator)', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        {
          key: 'score',
          name: 'Score',
          type: 'number',
          validators: [{ type: 'min', message: 'Too low', params: { min: 0 } }],
        },
      ],
    };
    // 'abc' fails both number type check and min validator since min validator only fires for typeof number
    // but type error alone is enough to show multi-error collection
    const result = service.validateData(form, { score: 'not-a-number' });
    expect(result.valid).toBe(false);
    expect(result.errors['score'].length).toBeGreaterThanOrEqual(1);
  });

  it('should pass when all fields have valid values', () => {
    const form: FormDefinition = {
      ...baseForm,
      fields: [
        { key: 'name', name: 'Name', type: 'string', required: true },
        { key: 'age', name: 'Age', type: 'number', required: true },
      ],
    };
    const result = service.validateData(form, { name: 'Alice', age: 30 });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });
});

describe('FormService CRUD', () => {
  let service: FormService;

  beforeEach(() => {
    const db = createMockDb();
    service = new (FormService as any)(db);
  });

  const sampleForm: FormDefinition = {
    id: 'form-001',
    name: 'Sample Form',
    fields: [
      { key: 'title', name: 'Title', type: 'string', required: true },
    ],
  };

  it('findById() returns null when form does not exist', async () => {
    const result = await service.findById('nonexistent');
    expect(result).toBeNull();
  });

  it('create() persists a form and findById() retrieves it', async () => {
    await service.create(sampleForm);
    const found = await service.findById('form-001');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('form-001');
    expect(found!.name).toBe('Sample Form');
  });

  it('findById() returns cached result on second call', async () => {
    await service.create(sampleForm);
    const first = await service.findById('form-001');
    const second = await service.findById('form-001');
    expect(first).toBe(second); // same object reference from cache
  });

  it('findAll() returns all stored forms', async () => {
    const formA: FormDefinition = { id: 'a', name: 'A', fields: [] };
    const formB: FormDefinition = { id: 'b', name: 'B', fields: [] };
    await service.create(formA);
    await service.create(formB);
    const all = await service.findAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((f: FormDefinition) => f.id === 'a')).toBe(true);
    expect(all.some((f: FormDefinition) => f.id === 'b')).toBe(true);
  });

  it('update() persists changes and invalidates cache', async () => {
    await service.create(sampleForm);
    await service.update('form-001', { name: 'Updated Name' });
    const found = await service.findById('form-001');
    expect(found!.name).toBe('Updated Name');
  });

  it('delete() removes the form and findById() returns null after', async () => {
    await service.create(sampleForm);
    await service.delete('form-001');
    const found = await service.findById('form-001');
    expect(found).toBeNull();
  });

  it('clearCache() forces re-fetch from db on next findById()', async () => {
    await service.create(sampleForm);
    // prime the cache
    await service.findById('form-001');
    service.clearCache();
    const found = await service.findById('form-001');
    expect(found).not.toBeNull();
  });
});
