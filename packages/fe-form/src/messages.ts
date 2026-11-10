import { createContext, useContext } from 'react';

/** Interface copy only; field labels and caller-authored validation messages stay untouched. */
export interface DynamicFormMessages {
  submitText: string;
  loadingText: string;
  /** Prefix placed before a loading error, including its punctuation. */
  loadFailedText: string;
  requiredText: string;
  selectPlaceholder: string;
  invalidJsonText: string;
  chooseFileText: string;
  /** Shown under an ENUM field whose remote dictionary options could not be loaded. */
  optionsLoadFailedText: string;
}

export const defaultFormMessages: Readonly<DynamicFormMessages> = {
  submitText: '提交',
  loadingText: '加载表单中...',
  loadFailedText: '加载表单失败：',
  requiredText: '该字段为必填项',
  selectPlaceholder: '请选择',
  invalidJsonText: '请输入合法的 JSON 格式',
  chooseFileText: '选择文件',
  optionsLoadFailedText: '选项加载失败',
};

export function resolveFormMessages(messages?: Partial<DynamicFormMessages>): DynamicFormMessages {
  const resolved = { ...defaultFormMessages };
  for (const key of Object.keys(resolved) as Array<keyof DynamicFormMessages>)
    resolved[key] = messages?.[key] ?? resolved[key];
  return resolved;
}

export const FormMessagesContext =
  createContext<Readonly<DynamicFormMessages>>(defaultFormMessages);
export const useFormMessages = () => useContext(FormMessagesContext);
