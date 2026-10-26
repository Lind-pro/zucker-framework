import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DynamicForm } from './DynamicForm';
import { FieldType } from './types';
import { resolveFormMessages } from './messages';
import { toAntdRules } from './validators';

describe('per-form interface messages', () => {
  it('keeps partial defaults and does not mutate a previous or subsequent instance', () => {
    const english = resolveFormMessages({ submitText: 'Send', requiredText: 'Required' });
    expect(english.submitText).toBe('Send');
    expect(english.chooseFileText).toBe('选择文件');
    expect(resolveFormMessages({ submitText: undefined }).submitText).toBe('提交');
    expect(resolveFormMessages().requiredText).toBe('该字段为必填项');
  });

  it('keeps authored field content and validation messages independent from interface locale', () => {
    const definition = {
      id: 'synthetic-form',
      name: 'Caller form',
      fields: [{ key: 'file', name: '用户自有字段名', type: FieldType.FILE }],
    };
    const html = renderToStaticMarkup(
      <>
        <DynamicForm
          definition={definition}
          onFinish={async () => {}}
          messages={{ submitText: 'English submit', chooseFileText: 'Choose attachment' }}
        />
        <DynamicForm definition={definition} onFinish={async () => {}} />
      </>,
    );
    expect(html).toContain('English submit');
    expect(html).toContain('Choose attachment');
    expect(html).toContain('选择文件');
    expect(html).toContain('用户自有字段名');
    expect(toAntdRules([{ type: 'required', message: 'Consumer rule' }], true, 'Required')).toEqual(
      [
        { required: true, message: 'Required' },
        { required: true, message: 'Consumer rule' },
      ],
    );
  });
});
