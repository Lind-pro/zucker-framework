import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { FormService, FormDefinition } from '@zucker-framework/form';
import { FormController } from './form.controller';

function controller(forms: FormDefinition[]): FormController {
  return new FormController({ findAll: async () => forms } as unknown as FormService);
}

const forms: FormDefinition[] = [
  { id: 'a', name: 'Customer Survey', fields: [] },
  { id: 'b', name: 'Order intake', fields: [] },
  { id: 'c', name: 'survey archive', fields: [] },
];

describe('FormController.queryDefinitions', () => {
  it('applies $like case-insensitively and $eq exactly', async () => {
    const like = await controller(forms).queryDefinitions({ filter: { name$like: 'SURVEY' } });
    expect(like.data.map((form) => form.id)).toEqual(['a', 'c']);
    expect(like.total).toBe(2);
    const eq = await controller(forms).queryDefinitions({ filter: { name$eq: 'Order intake' } });
    expect(eq.data.map((form) => form.id)).toEqual(['b']);
    const blank = await controller(forms).queryDefinitions({ filter: { name$like: '' } });
    expect(blank.total).toBe(3);
  });

  it('rejects filters outside the allow-list and invalid paging', async () => {
    await expect(controller(forms).queryDefinitions({ filter: { fields: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller(forms).queryDefinitions({ pageSize: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
