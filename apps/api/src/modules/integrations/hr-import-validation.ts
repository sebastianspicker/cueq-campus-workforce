/** Parses and validates HR master-data rows before a reconciliation transaction opens. */
import { Role } from '@cueq/database';
import { parseCsvRecords } from './csv/parse-csv.js';
import type { HrMasterRecord } from './hr-master-provider.port.js';

export const DEFAULT_ORGANIZATION_UNIT = 'Unassigned';
export const DEFAULT_WORK_TIME_MODEL = 'Default';
const DEFAULT_WEEKLY_HOURS = 39.83;
const DEFAULT_DAILY_TARGET_HOURS = 7.97;
export const MAX_HR_IMPORT_RECORDS = 10_000;

type OptionalHrFields =
  | 'role'
  | 'organizationUnit'
  | 'workTimeModel'
  | 'weeklyHours'
  | 'dailyTargetHours';

/** A field that is undefined was absent from the CSV header and must not overwrite stored data. */
export type ParsedHrImportRow = Omit<HrMasterRecord, OptionalHrFields> &
  Partial<Pick<HrMasterRecord, OptionalHrFields>>;

export type ValidatedHrImportRow = ParsedHrImportRow & {
  parsedRole: Role;
  parsedWeeklyHours: number;
  parsedDailyTargetHours: number;
  organizationUnitId: string;
  workTimeModelId: string;
  parsedEmploymentStartDate: Date | null;
  parsedEmploymentEndDate: Date | null;
};

function csvField(row: Record<string, string>, key: string, fallback: string): string {
  return (row[key] ?? fallback).trim();
}

function parsedRowFromCsv(row: Record<string, string>): ParsedHrImportRow {
  const supervisorExternalId = row['supervisorExternalId'];
  const employmentStartDate = row['employmentStartDate'];
  const employmentEndDate = row['employmentEndDate'];
  return {
    externalId: csvField(row, 'externalId', ''),
    firstName: csvField(row, 'firstName', ''),
    lastName: csvField(row, 'lastName', ''),
    email: csvField(row, 'email', ''),
    role: row['role'],
    organizationUnit: row['organizationUnit'],
    workTimeModel: row['workTimeModel'],
    weeklyHours: row['weeklyHours'],
    dailyTargetHours: row['dailyTargetHours'],
    supervisorExternalId: supervisorExternalId || undefined,
    employmentStartDate: employmentStartDate || undefined,
    employmentEndDate: employmentEndDate || undefined,
  };
}

function hasRequiredIdentity(row: ParsedHrImportRow): boolean {
  return Boolean(row.externalId && row.email && row.firstName && row.lastName);
}

function parseNonnegativeHours(value: string | undefined, fallback: number): number | null {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toRole(input: string): Role | null {
  const normalized = input.toUpperCase();
  return normalized in Role ? Role[normalized as keyof typeof Role] : null;
}

function parseEmploymentDate(value: string | undefined): Date | null | false {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? false
    : parsed;
}

function validateRow(
  row: ParsedHrImportRow,
  seenExternalIds: Set<string>,
  seenEmails: Set<string>,
): ValidatedHrImportRow | string {
  if (!hasRequiredIdentity(row)) {
    return `Missing required fields for externalId="${row.externalId}".`;
  }
  const normalizedEmail = row.email.toLowerCase();
  if (seenExternalIds.has(row.externalId)) {
    return `Duplicate externalId in batch: "${row.externalId}".`;
  }
  if (seenEmails.has(normalizedEmail)) return `Duplicate email in batch: "${row.email}".`;

  const parsedWeeklyHours = parseNonnegativeHours(row.weeklyHours, DEFAULT_WEEKLY_HOURS);
  const parsedDailyTargetHours = parseNonnegativeHours(
    row.dailyTargetHours,
    DEFAULT_DAILY_TARGET_HOURS,
  );
  if (parsedWeeklyHours === null) {
    return `Invalid weeklyHours for externalId="${row.externalId}".`;
  }
  if (parsedDailyTargetHours === null) {
    return `Invalid dailyTargetHours for externalId="${row.externalId}".`;
  }

  const parsedRole = toRole(row.role ?? 'EMPLOYEE');
  if (parsedRole === null) return `Unsupported HR role: ${row.role}`;

  const parsedEmploymentStartDate = parseEmploymentDate(row.employmentStartDate);
  const parsedEmploymentEndDate = parseEmploymentDate(row.employmentEndDate);
  if (parsedEmploymentStartDate === false) {
    return `Invalid employmentStartDate for externalId="${row.externalId}".`;
  }
  if (parsedEmploymentEndDate === false) {
    return `Invalid employmentEndDate for externalId="${row.externalId}".`;
  }
  if (
    parsedEmploymentStartDate &&
    parsedEmploymentEndDate &&
    parsedEmploymentEndDate < parsedEmploymentStartDate
  ) {
    return `employmentEndDate precedes employmentStartDate for externalId="${row.externalId}".`;
  }

  seenExternalIds.add(row.externalId);
  seenEmails.add(normalizedEmail);
  return {
    ...row,
    parsedRole,
    parsedWeeklyHours,
    parsedDailyTargetHours,
    organizationUnitId: `ou_${(row.organizationUnit ?? DEFAULT_ORGANIZATION_UNIT).toLowerCase().replace(/[^a-z0-9]+/giu, '_')}`,
    workTimeModelId: `wtm_${(row.workTimeModel ?? DEFAULT_WORK_TIME_MODEL).toLowerCase().replace(/[^a-z0-9]+/giu, '_')}`,
    parsedEmploymentStartDate,
    parsedEmploymentEndDate,
  };
}

/** A shared model id must carry one set of hours within a batch. */
function workTimeModelConflicts(rows: ValidatedHrImportRow[]): string[] {
  const errors: string[] = [];
  const modelRows = new Map<string, ValidatedHrImportRow>();
  for (const row of rows) {
    if (
      row.workTimeModel === undefined ||
      (row.weeklyHours === undefined && row.dailyTargetHours === undefined)
    )
      continue;
    const first = modelRows.get(row.workTimeModelId);
    if (!first) modelRows.set(row.workTimeModelId, row);
    else if (
      first.parsedWeeklyHours !== row.parsedWeeklyHours ||
      first.parsedDailyTargetHours !== row.parsedDailyTargetHours
    ) {
      errors.push(
        `Work time model "${row.workTimeModel}" has conflicting hours for externalId="${first.externalId}" and externalId="${row.externalId}".`,
      );
    }
  }
  return errors;
}

export function parseHrImportCsv(csv: string): ParsedHrImportRow[] {
  const { rows } = parseCsvRecords(csv);
  return rows.map(parsedRowFromCsv);
}

export function validateHrImportRows(rows: ParsedHrImportRow[]): {
  rows: ValidatedHrImportRow[];
  errors: string[];
} {
  if (rows.length > MAX_HR_IMPORT_RECORDS) {
    return {
      rows: [],
      errors: [`HR import exceeds the maximum of ${MAX_HR_IMPORT_RECORDS} records.`],
    };
  }
  const errors: string[] = [];
  const seenExternalIds = new Set<string>();
  const seenEmails = new Set<string>();
  const validatedRows: ValidatedHrImportRow[] = [];

  for (const row of rows) {
    const validated = validateRow(row, seenExternalIds, seenEmails);
    if (typeof validated === 'string') errors.push(validated);
    else validatedRows.push(validated);
  }

  errors.push(...workTimeModelConflicts(validatedRows));

  const byExternalId = new Map(validatedRows.map((row) => [row.externalId, row]));
  const leadsToCycle = new Map<string, boolean>();
  for (const row of validatedRows) {
    if (leadsToCycle.has(row.externalId)) continue;
    const path: string[] = [];
    const pathIndexes = new Map<string, number>();
    let currentId: string | undefined = row.externalId;
    let cyclic = false;
    while (currentId && byExternalId.has(currentId)) {
      const resolved = leadsToCycle.get(currentId);
      if (resolved !== undefined) {
        cyclic = resolved;
        break;
      }
      if (pathIndexes.has(currentId)) {
        cyclic = true;
        break;
      }
      pathIndexes.set(currentId, path.length);
      path.push(currentId);
      currentId = byExternalId.get(currentId)?.supervisorExternalId;
    }
    for (const pathId of path) leadsToCycle.set(pathId, cyclic);
  }
  for (const row of validatedRows) {
    if (leadsToCycle.get(row.externalId)) {
      errors.push(`Supervisor cycle detected for externalId="${row.externalId}".`);
    }
  }

  return { rows: validatedRows, errors: [...new Set(errors)] };
}
