import type { Rule } from 'antd/es/form';
import type { FieldValidator } from './types';

export function toAntdRules(validators: FieldValidator[] = [], required?: boolean): Rule[] {
  const rules: Rule[] = [];

  if (required) {
    rules.push({ required: true, message: '该字段为必填项' });
  }

  for (const v of validators) {
    switch (v.type) {
      case 'required':
        rules.push({ required: true, message: v.message });
        break;
      case 'minLength':
        rules.push({ min: v.params?.value as number, message: v.message });
        break;
      case 'maxLength':
        rules.push({ max: v.params?.value as number, message: v.message });
        break;
      case 'min':
        rules.push({ type: 'number', min: v.params?.value as number, message: v.message });
        break;
      case 'max':
        rules.push({ type: 'number', max: v.params?.value as number, message: v.message });
        break;
      case 'pattern':
        rules.push({ pattern: new RegExp(v.params?.value as string), message: v.message });
        break;
      case 'enum':
        rules.push({ type: 'enum', enum: v.params?.values as unknown[], message: v.message });
        break;
      case 'email':
        rules.push({ type: 'email', message: v.message });
        break;
      case 'url':
        rules.push({ type: 'url', message: v.message });
        break;
      default:
        break;
    }
  }

  return rules;
}
