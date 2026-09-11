import { expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryParamDto } from './query-param.dto';

it('transforms query strings while retaining default pagination', async () => {
  const query = plainToInstance(QueryParamDto, { page: '2', includes: 'id, title,,' });
  expect(query).toMatchObject({ page: 2, pageSize: 10, includes: ['id', 'title'] });
  expect(await validate(query)).toEqual([]);
});

it('rejects invalid projection and excessive pages at validation rather than throwing during transformation', async () => {
  const query = plainToInstance(QueryParamDto, { includes: 7, pageSize: '101' });
  const errors = await validate(query);
  expect(errors.map((error) => error.property).sort()).toEqual(['includes', 'pageSize']);
});
