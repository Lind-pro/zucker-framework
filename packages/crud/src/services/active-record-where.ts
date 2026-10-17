/** Preserve user/ownership/version conditions and add an independent active-record fence.
 * Keep unique keys at the top level for Prisma extended WhereUniqueInput.
 * The caller owns model selection, relation policy and privileged recovery access.
 */
export function withActiveRecordWhere(where: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...where, AND: [where, { deletedAt: null }] };
}
