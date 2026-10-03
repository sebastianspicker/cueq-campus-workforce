import { Role } from '@prisma/client';
import { parseCsvRecords } from './csv.mjs';

const MAX_HR_IMPORT_RECORDS = 10_000;

function recordField(row, key, fallback) {
  return row[key] ?? fallback;
}

function parsedRowFromRecord(row) {
  const supervisorExternalId = row.supervisorExternalId;
  const employmentStartDate = row.employmentStartDate;
  const employmentEndDate = row.employmentEndDate;
  return {
    externalId: recordField(row, 'externalId', ''),
    firstName: recordField(row, 'firstName', ''),
    lastName: recordField(row, 'lastName', ''),
    email: recordField(row, 'email', ''),
    role: recordField(row, 'role', 'EMPLOYEE'),
    organizationUnit: recordField(row, 'organizationUnit', 'Unassigned'),
    workTimeModel: recordField(row, 'workTimeModel', 'Default'),
    weeklyHours: recordField(row, 'weeklyHours', '39.83'),
    dailyTargetHours: recordField(row, 'dailyTargetHours', '7.97'),
    supervisorExternalId: supervisorExternalId || undefined,
    employmentStartDate: employmentStartDate || undefined,
    employmentEndDate: employmentEndDate || undefined,
  };
}

export function parseCsv(csv) {
  const { rows } = parseCsvRecords(csv);
  return rows.map(parsedRowFromRecord);
}

function slug(prefix, value) {
  return `${prefix}_${value.toLowerCase().replace(/[^a-z0-9]+/giu, '_')}`;
}

function toRole(input) {
  const normalized = String(input || 'EMPLOYEE').toUpperCase();
  if (Object.prototype.hasOwnProperty.call(Role, normalized)) {
    return Role[normalized];
  }

  throw new Error(`Unsupported HR role: ${input}`);
}

function parseEmploymentDate(value) {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? false
    : parsed;
}

export function validateRows(rows) {
  if (rows.length > MAX_HR_IMPORT_RECORDS) {
    return {
      validatedRows: [],
      errors: [`HR import exceeds the maximum of ${MAX_HR_IMPORT_RECORDS} records.`],
    };
  }
  const errors = [];
  const seenExternalIds = new Set();
  const seenEmails = new Set();

  const validatedRows = rows.flatMap((row) => {
    if (!row.externalId || !row.email || !row.firstName || !row.lastName) {
      errors.push(`Missing required fields for externalId="${row.externalId}".`);
      return [];
    }

    if (seenExternalIds.has(row.externalId)) {
      errors.push(`Duplicate externalId in batch: "${row.externalId}".`);
      return [];
    }
    if (seenEmails.has(row.email.toLowerCase())) {
      errors.push(`Duplicate email in batch: "${row.email}".`);
      return [];
    }

    seenExternalIds.add(row.externalId);
    seenEmails.add(row.email.toLowerCase());

    const weeklyHours = Number(row.weeklyHours || '39.83');
    const dailyTargetHours = Number(row.dailyTargetHours || '7.97');
    if (!Number.isFinite(weeklyHours) || weeklyHours < 0) {
      errors.push(`Invalid weeklyHours for externalId="${row.externalId}".`);
      return [];
    }
    if (!Number.isFinite(dailyTargetHours) || dailyTargetHours < 0) {
      errors.push(`Invalid dailyTargetHours for externalId="${row.externalId}".`);
      return [];
    }

    const parsedEmploymentStartDate = parseEmploymentDate(row.employmentStartDate);
    const parsedEmploymentEndDate = parseEmploymentDate(row.employmentEndDate);
    if (parsedEmploymentStartDate === false) {
      errors.push(`Invalid employmentStartDate for externalId="${row.externalId}".`);
      return [];
    }
    if (parsedEmploymentEndDate === false) {
      errors.push(`Invalid employmentEndDate for externalId="${row.externalId}".`);
      return [];
    }
    if (
      parsedEmploymentStartDate &&
      parsedEmploymentEndDate &&
      parsedEmploymentEndDate < parsedEmploymentStartDate
    ) {
      errors.push(
        `employmentEndDate precedes employmentStartDate for externalId="${row.externalId}".`,
      );
      return [];
    }

    return [
      {
        ...row,
        parsedRole: toRole(row.role),
        parsedWeeklyHours: weeklyHours,
        parsedDailyTargetHours: dailyTargetHours,
        organizationUnitId: slug('ou', row.organizationUnit),
        workTimeModelId: slug('wtm', row.workTimeModel),
        parsedEmploymentStartDate,
        parsedEmploymentEndDate,
      },
    ];
  });

  const byExternalId = new Map(validatedRows.map((row) => [row.externalId, row]));
  const leadsToCycle = new Map();
  for (const row of validatedRows) {
    if (leadsToCycle.has(row.externalId)) continue;
    const path = [];
    const pathIndexes = new Map();
    let currentId = row.externalId;
    let cyclic = false;
    while (currentId && byExternalId.has(currentId)) {
      if (leadsToCycle.has(currentId)) {
        cyclic = leadsToCycle.get(currentId);
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

  return { validatedRows, errors: [...new Set(errors)] };
}
