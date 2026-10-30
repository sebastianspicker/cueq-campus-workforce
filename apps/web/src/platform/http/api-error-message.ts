/** Builds the localized text shown for a failed API request; the server's own text stays as detail. */
import type { SafeApiErrorPayload } from '@cueq/contracts';

export type ApiErrorTranslator = (key: string) => string;
export type ApiErrorDescriber = (status: number, payload: SafeApiErrorPayload | null) => string;

/** API error codes with their own message under `app.apiErrors.codes`. */
const LOCALIZED_CODES = new Set([
  'ASSIGNMENT_NOT_EFFECTIVE',
  'ASSIGNMENT_REQUIRED',
  'CAPABILITY_REQUIRED',
  'CLOSING_PERIOD_LOCKED',
  'HR_IMPORT_VALIDATION_FAILED',
  'LEAVE_CALCULATION_POLICY_CONFLICT',
  'LEAVE_CALCULATION_POLICY_INVALID',
  'LEAVE_POLICY_INVALID',
  'LEAVE_WEEKLY_HOURS_REQUIRED',
  'MISSING_TIME_ACCOUNTS',
  'TIME_ACCOUNT_PARTIAL_DAY_POLICY_REQUIRED',
  'TIME_ACCOUNT_RECONCILIATION_REQUIRED',
  'TIME_ACCOUNT_SCHEDULE_REQUIRED',
]);

function statusKey(status: number): string {
  if (status === 400) return 'badRequest';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'notFound';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payloadTooLarge';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'tooManyRequests';
  if (status >= 500) return 'server';
  return 'other';
}

function summaryKey(status: number, code: string | undefined): string {
  if (code && LOCALIZED_CODES.has(code)) return `codes.${code}`;
  if (code?.endsWith('_IN_PROGRESS')) return 'codes.writeInProgress';
  if (code?.endsWith('_CHANGED')) return 'codes.changedConcurrently';
  return `status.${statusKey(status)}`;
}

export function describeApiError(
  t: ApiErrorTranslator,
  status: number,
  payload: SafeApiErrorPayload | null,
): string {
  const summary = t(summaryKey(status, payload?.code));
  const detail = payload?.message.trim();
  return detail ? `${summary} (${status}): ${detail}` : `${summary} (${status})`;
}
