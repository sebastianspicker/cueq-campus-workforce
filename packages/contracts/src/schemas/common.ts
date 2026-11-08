/** Common identifiers, dates, pagination, success, and error contracts shared across layers. */
import { z } from 'zod';

export const IdSchema = z.string().cuid();

export const DateTimeSchema = z.string().datetime();

/**
 * Compares validated ISO 8601 datetime strings by their instant, not their
 * textual representation. ISO fractions are variable-width, so lexical order
 * is not a safe ordering relation (for example, `...:00Z` sorts after
 * `...:00.001Z`).
 */
export const compareDateTimeInstants = (left: string, right: string): number =>
  Date.parse(left) - Date.parse(right);

export const isDateTimeInstantBefore = (left: string, right: string): boolean =>
  compareDateTimeInstants(left, right) < 0;

export const isDateTimeInstantOnOrBefore = (left: string, right: string): boolean =>
  compareDateTimeInstants(left, right) <= 0;

/** Maximum elapsed time accepted for one persisted booking-like work interval. */
export const MAX_BOOKING_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export const isBookingDurationAllowed = (start: string | Date, end: string | Date): boolean =>
  new Date(end).getTime() - new Date(start).getTime() <= MAX_BOOKING_DURATION_MS;

export function validateBookingDuration(
  input: { startTime?: string; endTime?: string },
  ctx: z.RefinementCtx,
): void {
  if (
    input.startTime &&
    input.endTime &&
    !isBookingDurationAllowed(input.startTime, input.endTime)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Booking duration must not exceed 7 days',
      path: ['endTime'],
    });
  }
}

export function validateOptionalDateTimeRange(
  input: { startTime?: string; endTime?: string },
  ctx: z.RefinementCtx,
  message: string,
): void {
  if (
    input.startTime &&
    input.endTime &&
    !isDateTimeInstantBefore(input.startTime, input.endTime)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['endTime'] });
  }
}

export function validateOptionalDateTimeQueryRange(
  input: { from?: string; to?: string },
  ctx: z.RefinementCtx,
  message: string,
): void {
  if (input.from && input.to && !isDateTimeInstantOnOrBefore(input.from, input.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['to'] });
  }
}

export const DateSchema = z.string().date();

export const PositiveDecimalSchema = z.number().nonnegative();

export const DateRangeSchema = z
  .object({
    start: DateTimeSchema,
    end: DateTimeSchema,
  })
  .refine((value) => isDateTimeInstantBefore(value.start, value.end), {
    message: 'start must be before end',
    path: ['end'],
  });
export type DateRange = z.infer<typeof DateRangeSchema>;

/**
 * Sanitized subset retained at the browser boundary for structured API errors.
 * Unknown response fields are deliberately stripped so arbitrary server bodies
 * are never kept in client error objects.
 */
export const SafeApiErrorPayloadSchema = z.object({
  statusCode: z.number().int().optional(),
  error: z.string().max(200).optional(),
  code: z.string().max(200).optional(),
  message: z.string().max(2000),
  correlationId: z.string().max(200).optional(),
  periodEnd: DateTimeSchema.optional(),
  retryable: z.boolean().optional(),
});
export type SafeApiErrorPayload = z.infer<typeof SafeApiErrorPayloadSchema>;

export const EmptyResponseSchema = z.null();
export type EmptyResponse = z.infer<typeof EmptyResponseSchema>;

export const UserIdentitySchema = z.object({
  id: IdSchema,
});
export type UserIdentity = z.infer<typeof UserIdentitySchema>;

export const UserProfileSchema = UserIdentitySchema.extend({
  email: z.string().email(),
  role: z.enum([
    'EMPLOYEE',
    'TEAM_LEAD',
    'SHIFT_PLANNER',
    'HR',
    'PAYROLL',
    'ADMIN',
    'DATA_PROTECTION',
    'WORKS_COUNCIL',
  ]),
  organizationUnitId: IdSchema,
  firstName: z.string(),
  lastName: z.string(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1000).optional(),
});

export function CursorPageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
