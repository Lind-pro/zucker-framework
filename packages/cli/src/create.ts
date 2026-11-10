/**
 * `@zucker-framework/cli/create`: the `zucker create` workspace generator as a function, for
 * `@zucker-framework/create-app`. CommonJS only: it locates the bundled templates next to this file.
 */
export { createCreateCommand, runCreate, type CreateOptions, type WorkspaceApp, type WorkspaceLocale } from './commands/create';
