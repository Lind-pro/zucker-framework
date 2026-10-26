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
