import { createContext, useContext } from 'react';

export interface AccessType {
  canAdmin: boolean;
  hasPermission: (code: string) => boolean;
}

export const AccessContext = createContext<AccessType>({
  canAdmin: false,
  hasPermission: () => false,
});

export function useAccess(): AccessType {
  return useContext(AccessContext);
}
