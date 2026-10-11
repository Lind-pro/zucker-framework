export interface GraphUpdateOptions<TState extends object> {
  initialState?: Partial<TState>;
  /** The current node payload is available even before a durable checkpoint becomes readable. */
  onNodeComplete?: (node: string, update?: Partial<TState>) => void | Promise<void>;
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
      const nodeUpdate = update && typeof update === 'object' && !Array.isArray(update)
        ? update as Partial<TState> : undefined;
      if (nodeUpdate) state = { ...state, ...nodeUpdate };
      await options.onNodeComplete?.(node, nodeUpdate);
    }
  }
  return state;
}
