---
'@zucker-framework/ai': patch
---

Add the optional `ImageProvider.editImage` capability and exported `ImageProviderSource` contract. OpenAI image edits send ordered PNG, JPEG or WebP sources through the SDK multipart edit endpoint, preserve the configured model ID, and retain cancellation, single-attempt retry controls and complete usage metadata. Invalid sources fail before dispatch; unsupported or failed edits never fall back to text-only generation.
