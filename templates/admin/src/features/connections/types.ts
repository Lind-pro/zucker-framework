export interface ConnectionField {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'boolean' | 'select' | 'number' | 'url';
  options?: string[];
  defaultValue?: string;
  description?: string;
  min?: number;
  max?: number;
  configured: boolean;
  source: 'saved' | 'environment' | 'default' | 'cleared' | 'unset';
  value?: string | null;
}
export interface ConnectionProfile {
  id: string;
  name: string;
  category: string;
  storedRevision: number;
  appliedRevision: number;
  pendingRestart: boolean;
  canSave: boolean;
  saveUnavailableReason: 'encryption_key_required' | null;
  fields: ConnectionField[];
}
export interface ConnectionSettings {
  profiles: ConnectionProfile[];
  appliesOn: 'server-restart';
  externalRequests: false;
}
