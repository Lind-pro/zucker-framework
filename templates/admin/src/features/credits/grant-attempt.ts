import { adminOperationAttempt, clearAdminOperationAttempt } from '@/lib/admin-operation-attempt';
export const grantAttempt = (actorId: string, body: unknown) =>
  adminOperationAttempt('credit-grant', actorId, body);
export const clearGrantAttempt = (actorId: string, key: string) =>
  clearAdminOperationAttempt('credit-grant', actorId, key);
