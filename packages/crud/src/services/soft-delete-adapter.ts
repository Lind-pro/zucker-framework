import { BadRequestException, NotFoundException } from '@nestjs/common';
import { withActiveRecordWhere } from './active-record-where';
import type { DatabaseAdapter, ModelOperations } from '@zucker-framework/core';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Internal service-local view. Never mutates the consumer's shared adapter. */
export function activeAdapter(db: DatabaseAdapter, modelName: string): DatabaseAdapter {
  const scope = (args: Record<string, unknown> = {}) => ({
    ...args,
    // Keep unique fields at the top level for Prisma extended WhereUniqueInput.
    where: withActiveRecordWhere(record(args.where)),
  });
  const write = (args: Record<string, unknown>, creating = false) => {
    const values = Array.isArray(args.data) ? args.data : [args.data];
    for (const value of values) {
      if (Object.prototype.hasOwnProperty.call(record(value), 'deletedAt') && !(creating && record(value).deletedAt === null)) {
        throw new BadRequestException('Use delete() or restore() to change deletedAt');
      }
    }
    return args;
  };
  const wrap = (ops: ModelOperations): ModelOperations => {
    const findFirst = ops.findFirst?.bind(ops);
    const aggregate = ops.aggregate?.bind(ops);
    const groupBy = ops.groupBy?.bind(ops);
    return {
      findUnique: args => ops.findUnique(scope(args)),
      ...(findFirst ? { findFirst: (args: Record<string, unknown>) => findFirst(scope(args)) } : {}),
      findMany: args => ops.findMany(scope(args)),
      count: args => ops.count(scope(args)),
      create: async args => {
        write(args, true);
        const data = record(args.data);
        // save() probes only active IDs. Do not let its create fallback overwrite
        // a retained ID on adapters that implement create as replacement.
        if (data.id) {
          const existing = await ops.findUnique({ where: { id: data.id } });
          if (record(existing).deletedAt != null) throw new NotFoundException(`${modelName} not found`);
        }
        return ops.create({ ...args, data: { ...data, deletedAt: null } });
      },
      createMany: async args => {
        write(args, true);
        const ids = (args.data as Record<string, unknown>[]).map(data => data.id).filter(Boolean);
        if (ids.length && (await ops.findMany({
          where: { id: { in: ids }, deletedAt: { not: null } }, select: { id: true },
        })).length) throw new NotFoundException(`${modelName} not found`);
        return ops.createMany({ ...args, data: (args.data as Record<string, unknown>[]).map(data => ({ ...data, deletedAt: null })) });
      },
      update: args => ops.update(scope(write(args))),
      updateMany: args => ops.updateMany(scope(write(args))),
      delete: args => ops.update({ ...scope(args), data: { deletedAt: new Date() } }),
      deleteMany: args => ops.updateMany({ ...scope(args), data: { deletedAt: new Date() } }),
      ...(aggregate ? { aggregate: (args: Record<string, unknown>) => aggregate(scope(args)) } : {}),
      ...(groupBy ? { groupBy: (args: Record<string, unknown>) => groupBy(scope(args)) } : {}),
    };
  };
  return {
    model: name => name === modelName ? wrap(db.model(name)) : db.model(name),
    $transaction: fn => db.$transaction(tx => fn(activeAdapter(tx, modelName))),
  };
}
