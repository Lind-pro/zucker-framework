import React, { ReactNode, useMemo } from 'react';
import { AccessContext, AccessType } from '../hooks/useAccess';
import useAuthStore from '../stores/useAuthStore';

interface AccessProviderProps {
  children: ReactNode;
}

const AccessProvider: React.FC<AccessProviderProps> = ({ children }) => {
  const { permissions, hasPermission } = useAuthStore();

  const access = useMemo<AccessType>(() => {
    const isAdmin = permissions.includes('*') || permissions.includes('superadmin');
    return {
      canAdmin: isAdmin,
      hasPermission,
    };
  }, [permissions, hasPermission]);

  return (
    <AccessContext.Provider value={access}>
      {children}
    </AccessContext.Provider>
  );
};

export default AccessProvider;
