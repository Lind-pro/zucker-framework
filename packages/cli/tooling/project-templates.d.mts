export type TemplateAssets = Record<string, string>;
export interface ProjectBundle {
  version: 1;
  consumerInstructions: string;
  templates: Record<'admin' | 'web' | 'server-full', TemplateAssets> & { workspace?: TemplateAssets };
  /** Assistant skills `{ '<skill>/<path>': base64 }` installed into `.agents/skills`; absent in older bundles. */
  skills?: Record<string, string>;
}
export interface TemplateAssetOptions {
  /** Require a package.json manifest (default true). */
  manifest?: boolean;
}
export declare const workspaceRequiredAssets: readonly string[];
export declare function isTemplateAsset(path: string): boolean;
export declare function collectTemplateAssets(directory: string): TemplateAssets;
export declare function validateTemplateAssets(files: unknown, options?: TemplateAssetOptions): asserts files is TemplateAssets;
export declare function validateProjectBundle(bundle: unknown): asserts bundle is ProjectBundle;
export declare function writeTemplateAssets(files: TemplateAssets, directory: string, options?: TemplateAssetOptions): void;
