import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  type HttpException,
} from '@nestjs/common';
import { PORT_ERROR_STATUS, isPortError, type PortErrorBody } from '@zucker-framework/fe-types/back-office';

const EXCEPTION: Record<PortErrorBody['statusCode'], new (body: object, options?: { cause?: unknown }) => HttpException> = {
  400: BadRequestException,
  404: NotFoundException,
  409: ConflictException,
  503: ServiceUnavailableException,
};

/**
 * Translates branded domain port errors (PlanCatalogError, SubscriptionAssignmentError,
 * QuotaReservationError, ResourceChargeError — see `PORT_ERROR` in `@zucker-framework/fe-types`)
 * into HTTP errors with one status per reason. Anything else, including foreign errors that merely
 * carry a `reason` property, propagates unchanged to the host's filter.
 */
export function mapPortError(error: unknown): never {
  if (isPortError(error)) {
    const status = PORT_ERROR_STATUS[error.reason];
    const issues = Array.isArray(error.issues) ? error.issues.filter((item): item is string => typeof item === 'string') : [];
    const body: PortErrorBody = {
      statusCode: status,
      message: error.message,
      code: error.reason,
      reason: error.reason,
      ...(issues.length ? { issues } : {}),
      ...(error.details ? { details: { ...error.details } } : {}),
    };
    throw new EXCEPTION[status](body, { cause: error });
  }
  throw error;
}

export async function viaPort<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    mapPortError(error);
  }
}
