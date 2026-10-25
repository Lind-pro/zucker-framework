# Dictionary storage and compatibility

`DictionaryService` and `DictionaryItemService` use the existing `dictionary` and `dictionaryItem`
model aliases. The template maps these to `dictionaries` and `dictionaryItems`; no additional
schema columns are needed for the default Admin manager.

Dictionary items are persisted as `text`, `value`, `ordinal`, `describe`, and their existing
relationship/status/search/properties fields. `DictionaryItemInput` accepts canonical `text` and
`ordinal`; existing callers may continue to supply `name` and `sortIndex`. Canonical values take
precedence when both are supplied. The public `description` input maps to stored `describe`.
The existing `valueType` hint is stored in `properties.valueType`, preserving other properties.

Service reads and writes return canonical values plus the compatibility aliases `name`,
`sortIndex`, and `description`. A canonical row's `name` equals `text`, and `sortIndex` equals
`ordinal`. List/search queries and tree ordering use `ordinal`; absent ordinals continue from
the current maximum within that dictionary. This is ordering metadata, not a uniqueness or
concurrency guarantee.

The default Admin APIs also accept the former UI's `label`/`sortIndex` payloads. Creation,
query, edit, permission isolation, conflict handling and failed-write recovery are verified
against the unchanged template schema in `templates/server/test/dictionary.persistent.e2e-spec.ts`.
