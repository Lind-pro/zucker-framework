---
"@zucker-framework/storage": minor
---

Export UnavailableFileManager for explicitly disabled storage: writes and downloads reject, existence returns false and listing returns an empty array. Consumers provide their own localized configuration error. Enables direct FILE_MANAGER injection without a consumer forwarding service or duplicate lifecycle provider.
