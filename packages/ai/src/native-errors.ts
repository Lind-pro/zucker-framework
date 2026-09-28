/** Non-retryable protocol/configuration failure; repeating the same request cannot fix it. */
export class NativeAIContractError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'NativeAIContractError';
  }
}
