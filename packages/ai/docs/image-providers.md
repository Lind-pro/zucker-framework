# Encoded image providers

`ImageProvider` returns an encoded image (`imageBase64`, `mimeType`, optional revised prompt and provider metadata). It is separate from the existing `MediaProvider` job/URL contract. `OpenAIImageProvider` supports GPT-image options, cancellation, the SDK's request id/usage response and a URL-download fallback; `DalleProvider` retains its DALL-E-specific behavior.

OpenAI construction requires explicit model, quality, size, output format and moderation. The application owns these defaults and routing. Optional timeout overrides the effectively unbounded SDK timer safety limit (2,147,000,000 ms); cancellation remains caller-driven. Per-call recognized provider options override defaults, and image count stays within 1–10. SDK/abort failures propagate; missing image content rejects.

`GeminiImageProvider` takes explicit API key/model and optional timeout, extracts the first nonempty image part and accompanying text, and propagates the caller's abort signal. It retains the original single-image extraction behavior; aspect-ratio/count options are not silently presented as supported Gemini parameters. Cancelling client-side SDK work does not guarantee a provider-side charge is cancelled.

SDK peers (`openai`, `@google/genai`) are loaded lazily and remain external to the package. Consumers install only the providers they select. Tests use SDK replacements and synthetic outputs. No real-provider calls, builds or publication were performed for this source migration. Package versions/lockfiles and artifact delivery remain a separate authorized release stage.
