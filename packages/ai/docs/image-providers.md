# Encoded image providers

`ImageProvider` returns an encoded image (`imageBase64`, `mimeType`, optional revised prompt and provider metadata). It is separate from the existing `MediaProvider` job/URL contract. `OpenAIImageProvider` supports GPT-image options, cancellation, the SDK's request id/usage response and a URL-download fallback; `DalleProvider` retains its DALL-E-specific behavior.

OpenAI construction requires explicit model, quality, size, output format and moderation. The application owns these defaults and routing. Optional timeout overrides the effectively unbounded SDK timer safety limit (2,147,000,000 ms); cancellation remains caller-driven. Per-call recognized provider options override defaults, and image count stays within 1–10. SDK/abort failures propagate; missing image content rejects.

`GeminiImageProvider` takes explicit API key/model and optional timeout, extracts the first nonempty image part and accompanying text, and propagates the caller's abort signal. It retains the original single-image extraction behavior; aspect-ratio/count options are not silently presented as supported Gemini parameters. Cancelling client-side SDK work does not guarantee a provider-side charge is cancelled.

Both providers advertise `supportsSingleAttempt: true`. Callers requiring a single paid attempt must check that capability and pass `maxRetries: 0`: OpenAI sets the SDK request's `maxRetries` to zero, while Gemini sets `httpOptions.retryOptions.attempts` to one (the initial request). Omitting the option preserves each SDK's ordinary retry defaults. Values other than zero reject before SDK dispatch.

`ImageProviderResult.usage` exposes reported `inputTokens`, `outputTokens`, `totalTokens`, and optional input/output modality counts such as `text` and `image`. Missing counts stay unknown. Gemini output tokens include reported candidate and reasoning tokens; its output modality counts describe candidates only. The complete usage response remains in `usage.raw` and in `providerMeta.usage`, including cache, reasoning and tool token categories. OpenAI preserves usage for both encoded and URL image responses. Providers do not infer missing modalities, choose prices or settle a consumer's budget; the caller must use the categories required by its billing rules.

SDK peers (`openai`, `@google/genai`) are loaded lazily and remain external to the package. Consumers install only the providers they select. Tests use SDK replacements and synthetic outputs. The earlier scoped AI patch release delivered the OpenAI editing, retry and usage contracts described below; the Gemini retry and usage additions are pending a new package release. Synthetic transport tests do not establish real model quality or account availability.

## Source-image editing

`ImageProviderSource` is the product-neutral `{ imageBase64: string; mimeType: string }` source contract. `ImageProvider.editImage(prompt, sources, options)` is optional: check the method before use and report an unsupported route instead of substituting `generateImage`, which would discard the original pixels. `OpenAIImageProvider` implements editing with the SDK's multipart `images.edit` request; every source becomes an ordered upload, allowing the caller to describe a main image and additional visual references in its prompt.

```ts
import type { ImageProvider, ImageProviderSource } from '@zucker-framework/ai';

async function edit(provider: ImageProvider, instruction: string, sources: ImageProviderSource[], signal: AbortSignal) {
  if (!provider.editImage || !provider.supportsSingleAttempt) {
    throw new Error('The configured image route does not support single-attempt source editing');
  }
  return provider.editImage(instruction, sources, { signal, maxRetries: 0, numberOfImages: 1 });
}
```

The OpenAI adapter accepts 1–16 source images, each smaller than 50 MiB, with canonical base64 and a PNG, JPEG or WebP signature matching its declared MIME type. Empty, malformed, mismatched and excessive sources reject before SDK dispatch. Source URLs, storage access, ownership, masks, visual verification and consumer billing policy are not part of this method. The application can impose stricter source limits. Cancellation is checked during preparation and passed to the SDK and any output download; a caller cancellation does not prove that the provider avoided charging.

Editing forwards the configured model ID unchanged, including `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` or a deployment alias when that route provides them. This is routing support, not a claim that every account has access. The existing quality, size and output-format options remain available. The adapter does not inject `input_fidelity`, whose support differs by model. The official edit API lists `moderation`, but the pinned OpenAI 7.9 SDK edit type does not expose it; editing therefore leaves the endpoint moderation default in place rather than bypassing the SDK type.

Editing uses the same `maxRetries: 0` single-attempt behavior and complete `usage`/request metadata as generation, adding `providerMeta.operation: 'edit'` and `sourceImageCount`. An edit error never triggers text-only generation. Provider and multipart serialization tests use synthetic transports; they do not establish real model quality or account availability.

API reference: [Edit images](https://developers.openai.com/api/reference/resources/images/methods/edit).
