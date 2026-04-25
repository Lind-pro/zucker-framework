export const REFERENCE_ADDED_EVENT = 'zucker.reference.added';
export const REFERENCE_REMOVED_EVENT = 'zucker.reference.removed';

export interface ReferenceChangeEvent {
  dataType: string;
  dataId: string;
  referenceType: string;
  referenceId: string;
  referenceName?: string;
  action: 'added' | 'removed';
  timestamp: Date;
}
