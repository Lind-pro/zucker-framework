/** SDK-specific adapters are opt-in; importing the root port does not require their types. */
export { createNativeAIModel, openAINativeModel, anthropicNativeModel, geminiNativeModel } from './native-providers';
export type { NativeTransportOptions } from './native-providers';
