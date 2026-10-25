export interface PrivateFile {
  id: string;
  fileName: string;
  size: number;
  mimeType: string;
  state: 'pending' | 'ready' | 'deleted';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  cleanupStatus: 'pending' | 'confirmed' | null;
  cleanupConfirmedAt: string | null;
}
export interface FilePage {
  data: PrivateFile[];
  total: number;
  page: number;
  pageSize: number;
  limits: { maxFileBytes: number; urlImportEnabled: boolean };
}
export interface DownloadTicket {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
}
