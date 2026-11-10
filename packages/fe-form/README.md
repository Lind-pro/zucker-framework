# Dynamic forms

`DynamicForm` renders a caller-owned `FormDefinition`. Its optional `messages` property supplies
instance-local interface text: `submitText`, `loadingText`, `loadFailedText` (an error prefix including
punctuation), `requiredText`, `selectPlaceholder`, `invalidJsonText`, and `chooseFileText`.
Omitted properties retain the existing Chinese defaults. The existing `submitText` prop takes
precedence over `messages.submitText`.

Changing messages does not remount the form or translate field names, descriptions, options or
caller-authored validator messages. Set the surrounding Ant Design locale for built-in widgets.
`toAntdRules(validators, required, requiredMessage?)` also accepts a default required-message override;
explicit validator messages are preserved.

## Loading by id and submitted values

`formId` loads `GET {definitionBasePath ?? '/api'}/form/definition/<id>`. That endpoint requires a
signed-in user with `form:query`, so pass an authenticated `httpGet(url, signal)`; it may resolve the
definition or the framework response envelope.

Validator parameters follow `@zucker-framework/form` (`min`, `max`, `pattern`; legacy `value` is still
read). Invalid patterns are skipped. `onFinish` receives server-shaped values: JSON fields as objects,
ARRAY fields as arrays (typed by `elementType`), DATE as `YYYY-MM-DD`, DATETIME as ISO strings and FILE
fields as the results of `uploadFile(file, field)` (raw `File` objects when no uploader is given).
`field.defaultValue` seeds the form unless `initialValues` supplies the key.
