---
"@zucker-framework/ai": patch
---

Advertise Gemini image generation's single-attempt capability and map maxRetries: 0 to one SDK
attempt without changing ordinary retry defaults. Preserve complete provider usage, request and
model metadata, including candidate/reasoning totals and reported modality counts. Missing usage
remains unknown, and unsupported retry values reject before provider dispatch.
