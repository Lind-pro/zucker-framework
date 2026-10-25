export type TemplateAssets = Record<string, string>;
export interface ProjectBundle {
  version: 1;
  consumerInstructions: string;
  templates: Record<'admin' | 'web' | 'server-full', TemplateAssets>;
}
export declare function isTemplateAsset(path: string): boolean;
export declare function collectTemplateAssets(directory: string): TemplateAssets;
export declare function validateTemplateAssets(files: unknown): asserts files is TemplateAssets;
export declare function validateProjectBundle(bundle: unknown): asserts bundle is ProjectBundle;
export declare function writeTemplateAssets(files: TemplateAssets, directory: string): void;
