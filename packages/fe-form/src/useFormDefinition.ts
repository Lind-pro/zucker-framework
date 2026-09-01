import { useState, useEffect } from 'react';
import type { FormDefinition } from './types';

interface State {
  definition: FormDefinition | null;
  loading: boolean;
  error: string | null;
}

/**
 * 从后端 GET /form/definition/:id 加载表单定义。
 * 使用方传入 httpGet 函数以保持包对 HTTP 客户端无依赖。
 */
export function useFormDefinition(
  formId?: string,
  httpGet?: (url: string) => Promise<FormDefinition>,
): State {
  const [state, setState] = useState<State>({ definition: null, loading: false, error: null });

  useEffect(() => {
    if (!formId) return;

    setState({ definition: null, loading: true, error: null });

    const fetcher = httpGet ?? ((url: string) =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<FormDefinition>;
      }));

    fetcher(`/api/form/definition/${formId}`)
      .then((definition) => setState({ definition, loading: false, error: null }))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '未知错误';
        setState({ definition: null, loading: false, error: msg });
      });
  }, [formId, httpGet]);

  return state;
}
