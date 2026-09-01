/**
 * Password encoder interface.
 *
 * Reference: hsweb-framework PasswordEncoder
 */
export interface PasswordEncoder {
  /**
   * Encode a raw password into a secure hash.
   */
  encode(raw: string): Promise<string>;

  /**
   * Check if a raw password matches the encoded hash.
   */
  matches(raw: string, encoded: string): Promise<boolean>;
}
