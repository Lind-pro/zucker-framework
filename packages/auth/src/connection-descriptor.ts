/**
 * Plain-data connection descriptors for OAuth sign-in providers: profile id, environment keys, field types,
 * English display text and stable translation keys. It has no runtime dependency; an application turns
 * it into a saved connection profile with `localizeConnectionDescriptor` from
 * `@zucker-framework/config/connections` (matched structurally) and adds its own validation.
 * Ids and environment keys are a storage contract: saved configuration is keyed by them, so never rename one.
 */
export type AuthConnectionFieldType = 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
export interface AuthConnectionDescriptorField {
  readonly key: string; readonly label: string; readonly labelKey: string; readonly type: AuthConnectionFieldType;
  readonly options?: readonly string[]; readonly defaultValue?: string; readonly description?: string; readonly min?: number; readonly max?: number;
}
export interface AuthConnectionDescriptor {
  readonly profile: {
    readonly id: string; readonly name: string; readonly labelKey: string; readonly category: string; readonly categoryKey: string;
    readonly fields: readonly AuthConnectionDescriptorField[];
  };
}

export const GOOGLE_OAUTH_CONNECTION_DESCRIPTOR: AuthConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'identity-google', name: 'Google sign-in', labelKey: 'connections.identity-google', category: 'Sign-in', categoryKey: 'connections.category.sign-in',
    fields: Object.freeze<AuthConnectionDescriptorField[]>([
      { key: 'GOOGLE_OAUTH_ENABLED', label: 'OAuth sign-in', labelKey: 'connections.field.GOOGLE_OAUTH_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'GOOGLE_ONE_TAP_ENABLED', label: 'One Tap', labelKey: 'connections.field.GOOGLE_ONE_TAP_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', labelKey: 'connections.field.GOOGLE_CLIENT_ID', type: 'text' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', labelKey: 'connections.field.GOOGLE_CLIENT_SECRET', type: 'secret' },
    ]) }),
});
export const GITHUB_OAUTH_CONNECTION_DESCRIPTOR: AuthConnectionDescriptor = Object.freeze({
  profile: Object.freeze({ id: 'identity-github', name: 'GitHub sign-in', labelKey: 'connections.identity-github', category: 'Sign-in', categoryKey: 'connections.category.sign-in',
    fields: Object.freeze<AuthConnectionDescriptorField[]>([
      { key: 'GITHUB_OAUTH_ENABLED', label: 'Enabled', labelKey: 'connections.field.GITHUB_OAUTH_ENABLED', type: 'boolean', defaultValue: 'false' },
      { key: 'GITHUB_CLIENT_ID', label: 'Client ID', labelKey: 'connections.field.GITHUB_CLIENT_ID', type: 'text' },
      { key: 'GITHUB_CLIENT_SECRET', label: 'Client secret', labelKey: 'connections.field.GITHUB_CLIENT_SECRET', type: 'secret' },
    ]) }),
});
export const OAUTH_CONNECTION_DESCRIPTORS: readonly AuthConnectionDescriptor[] = Object.freeze([GOOGLE_OAUTH_CONNECTION_DESCRIPTOR, GITHUB_OAUTH_CONNECTION_DESCRIPTOR]);
