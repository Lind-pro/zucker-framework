import { Injectable, Inject, Logger } from '@nestjs/common';
import { coerceComparable } from '../query/coerce-comparable';

export type FilterOperatorType =
  | 'eq'
  | 'neq'
  | 'like'
  | 'notLike'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'isNotNull'
  | 'between'
  | 'has'
  | 'hasSome'
  | 'empty'
  | 'notEmpty';

export interface IFilterOperator {
  readonly operatorType: FilterOperatorType;
  apply(field: string, value: unknown): Record<string, unknown> | null;
}

export const FILTER_OPERATORS = 'FILTER_OPERATORS';

@Injectable()
export class EqualsOperator implements IFilterOperator {
  readonly operatorType = 'eq' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { equals: value } };
  }
}

@Injectable()
export class NotEqualsOperator implements IFilterOperator {
  readonly operatorType = 'neq' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { not: value } };
  }
}

@Injectable()
export class LikeOperator implements IFilterOperator {
  readonly operatorType = 'like' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { contains: value, mode: 'insensitive' } };
  }
}

@Injectable()
export class ContainsOperator implements IFilterOperator {
  readonly operatorType = 'contains' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { contains: value, mode: 'insensitive' } };
  }
}

@Injectable()
export class GtOperator implements IFilterOperator {
  readonly operatorType = 'gt' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { gt: coerceComparable(value, 'end') } };
  }
}

@Injectable()
export class GteOperator implements IFilterOperator {
  readonly operatorType = 'gte' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { gte: coerceComparable(value, 'start') } };
  }
}

@Injectable()
export class LtOperator implements IFilterOperator {
  readonly operatorType = 'lt' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { lt: coerceComparable(value, 'start') } };
  }
}

@Injectable()
export class LteOperator implements IFilterOperator {
  readonly operatorType = 'lte' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { lte: coerceComparable(value, 'end') } };
  }
}

@Injectable()
export class InOperator implements IFilterOperator {
  readonly operatorType = 'in' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    const arr = Array.isArray(value) ? value : [value];
    return { [field]: { in: arr } };
  }
}

@Injectable()
export class NotInOperator implements IFilterOperator {
  readonly operatorType = 'notIn' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    const arr = Array.isArray(value) ? value : [value];
    return { [field]: { notIn: arr } };
  }
}

@Injectable()
export class IsNullOperator implements IFilterOperator {
  readonly operatorType = 'isNull' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return value ? { [field]: { equals: null } } : { [field]: { not: null } };
  }
}

@Injectable()
export class BetweenOperator implements IFilterOperator {
  readonly operatorType = 'between' as const;
  apply(field: string, value: unknown): Record<string, unknown> | null {
    if (!Array.isArray(value) || value.length !== 2) return null;
    return {
      [field]: {
        gte: coerceComparable(value[0], 'start'),
        lte: coerceComparable(value[1], 'end'),
      },
    };
  }
}

@Injectable()
export class HasOperator implements IFilterOperator {
  readonly operatorType = 'has' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { has: value } };
  }
}

@Injectable()
export class HasSomeOperator implements IFilterOperator {
  readonly operatorType = 'hasSome' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    const arr = Array.isArray(value) ? value : [value];
    return { [field]: { hasSome: arr } };
  }
}

@Injectable()
export class NotLikeOperator implements IFilterOperator {
  readonly operatorType = 'notLike' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { NOT: { [field]: { contains: value, mode: 'insensitive' } } };
  }
}

@Injectable()
export class StartsWithOperator implements IFilterOperator {
  readonly operatorType = 'startsWith' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { startsWith: String(value) } };
  }
}

@Injectable()
export class EndsWithOperator implements IFilterOperator {
  readonly operatorType = 'endsWith' as const;
  apply(field: string, value: unknown): Record<string, unknown> {
    return { [field]: { endsWith: String(value) } };
  }
}

@Injectable()
export class IsNotNullOperator implements IFilterOperator {
  readonly operatorType = 'isNotNull' as const;
  apply(field: string, _value: unknown): Record<string, unknown> {
    return { [field]: { not: null } };
  }
}

@Injectable()
export class EmptyOperator implements IFilterOperator {
  readonly operatorType = 'empty' as const;
  apply(field: string, _value: unknown): Record<string, unknown> {
    return { OR: [{ [field]: { equals: null } }, { [field]: { equals: '' } }] };
  }
}

@Injectable()
export class NotEmptyOperator implements IFilterOperator {
  readonly operatorType = 'notEmpty' as const;
  apply(field: string, _value: unknown): Record<string, unknown> {
    return { AND: [{ [field]: { not: null } }, { NOT: { [field]: { equals: '' } } }] };
  }
}

export const ALL_OPERATORS = [
  EqualsOperator,
  NotEqualsOperator,
  LikeOperator,
  NotLikeOperator,
  ContainsOperator,
  StartsWithOperator,
  EndsWithOperator,
  GtOperator,
  GteOperator,
  LtOperator,
  LteOperator,
  InOperator,
  NotInOperator,
  IsNullOperator,
  IsNotNullOperator,
  BetweenOperator,
  HasOperator,
  HasSomeOperator,
  EmptyOperator,
  NotEmptyOperator,
];

@Injectable()
export class FilterOperatorFactory {
  private readonly logger = new Logger(FilterOperatorFactory.name);
  private readonly operatorMap: Map<FilterOperatorType, IFilterOperator>;

  constructor(
    @Inject(FILTER_OPERATORS) private readonly operators: IFilterOperator[],
  ) {
    this.operatorMap = new Map(
      operators.map((op) => [op.operatorType, op]),
    );
    this.logger.log(`过滤操作符已注册: ${operators.map((op) => op.operatorType).join(', ')}`);
  }

  /** Normalize hyphen-style aliases (e.g. 'is-null' → 'isNull') to camelCase keys */
  private normalizeType(operatorType: string): string {
    const aliases: Record<string, string> = {
      'is-null': 'isNull',
      'is-not-null': 'isNotNull',
      'not-like': 'notLike',
      'not-in': 'notIn',
      'starts-with': 'startsWith',
      'ends-with': 'endsWith',
      'has-some': 'hasSome',
      'not-empty': 'notEmpty',
    };
    return aliases[operatorType] ?? operatorType;
  }

  getOperator(operatorType: string): IFilterOperator | null {
    return this.operatorMap.get(this.normalizeType(operatorType) as FilterOperatorType) || null;
  }

  applyFilter(field: string, operatorType: string, value: unknown): Record<string, unknown> | null {
    const operator = this.getOperator(operatorType);
    if (!operator) {
      return { [field]: value };
    }
    return operator.apply(field, value);
  }

  getSupportedOperators(): FilterOperatorType[] {
    return Array.from(this.operatorMap.keys());
  }

  isOperatorSupported(operatorType: string): boolean {
    return this.operatorMap.has(operatorType as FilterOperatorType);
  }
}
