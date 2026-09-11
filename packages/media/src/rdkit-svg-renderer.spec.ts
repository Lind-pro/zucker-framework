import { describe, expect, it, vi } from 'vitest';
import { renderSmilesSvg, InvalidSmilesError } from './rdkit-svg-renderer';

describe('renderSmilesSvg', () => {
  it('releases each WASM molecule after successful rendering', async () => {
    const molecule = { is_valid: () => true, get_svg: () => '<svg/>', delete: vi.fn() };
    await expect(renderSmilesSvg('CCO', { get_mol: () => molecule })).resolves.toMatchObject({
      svg: '<svg/>',
    });
    expect(molecule.delete).toHaveBeenCalledTimes(1);
  });
  it('releases invalid molecules and molecules whose SVG generation fails', async () => {
    const molecule = { is_valid: () => false, get_svg: vi.fn(), delete: vi.fn() };
    await expect(renderSmilesSvg('invalid', { get_mol: () => molecule })).rejects.toBeInstanceOf(
      InvalidSmilesError,
    );
    expect(molecule.delete).toHaveBeenCalledTimes(1);
    const error = new Error('render failed');
    const failing = {
      is_valid: () => true,
      get_svg: () => {
        throw error;
      },
      delete: vi.fn(),
    };
    await expect(renderSmilesSvg('CCO', { get_mol: () => failing })).rejects.toBe(error);
    expect(failing.delete).toHaveBeenCalledTimes(1);
  });
});
