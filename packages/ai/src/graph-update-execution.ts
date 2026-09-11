export interface GraphUpdateOptions<TState extends object> {
  initialState?: Partial<TState>;
  onNodeComplete?: (node: string) => void | Promise<void>;
}

/**
 * Consume a graph's update stream without taking ownership of its topology,
 * reducers or checkpoints. The merged return value is suitable only for
 * replacement fields; checkpointed/reducer graphs should read their own state.
 */
export async function collectGraphUpdates<TState extends object>(
  updates: AsyncIterable<Record<string, unknown>>,
  options: GraphUpdateOptions<TState> = {},
): Promise<Partial<TState>> {
  let state: Partial<TState> = { ...options.initialState };
  for await (const event of updates) {
    for (const [node, update] of Object.entries(event)) {
      if (update && typeof update === 'object') state = { ...state, ...update };
      await options.onNodeComplete?.(node);
    }
  }
  return state;
}
