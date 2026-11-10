import { Button, errorBody, errorStatus, isAbortError, useAdminApi } from '@zucker-framework/fe-admin';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useText } from '../../text';

/** Response of `POST /management/public-assets` (WP 2.6). */
export interface PublicAssetUpload {
  sha256: string;
  url: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  deduplicated: boolean;
}

export const PUBLIC_ASSET_UPLOAD_PATH = '/management/public-assets';
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/**
 * Uploads one raster image as a public asset (content:manage, trusted Origin on the server) and hands
 * back its immutable URL. SVG and non-images are rejected by the server (415); the server's message is
 * shown for 413/415/422 so the operator knows why.
 */
export function PublicAssetUploadButton({ onUploaded, disabled, label }: {
  onUploaded: (url: string, asset: PublicAssetUpload) => void;
  disabled?: boolean;
  label?: string;
}) {
  const api = useAdminApi();
  const tx = useText();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setProblem(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const asset = await api.post<PublicAssetUpload>(PUBLIC_ASSET_UPLOAD_PATH, form);
      if (!asset || typeof asset.url !== 'string' || !asset.url) throw new Error('No URL returned');
      onUploaded(asset.url, asset);
    } catch (error) {
      if (isAbortError(error)) return;
      const status = errorStatus(error);
      const message = errorBody(error).message;
      setProblem(status === 413 || status === 415 || status === 422
        ? (message ?? tx('图片不符合要求', 'The image was rejected'))
        : status === 403
          ? tx('没有上传权限', 'You are not allowed to upload')
          : tx('上传失败，请重试', 'Upload failed, try again'));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <span className="inline-flex flex-col gap-1">
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <Button size="sm" variant="outline" icon={<Upload />} disabled={disabled || busy} onClick={() => input.current?.click()}>
        {busy ? tx('上传中…', 'Uploading…') : (label ?? tx('上传图片', 'Upload image'))}
      </Button>
      {problem && <span role="alert" className="text-xs text-destructive">{problem}</span>}
    </span>
  );
}
