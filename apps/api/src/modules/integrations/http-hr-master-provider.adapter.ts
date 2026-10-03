/** Fetches and validates HR master data from the configured HTTP provider. */
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { HrMasterProviderPort, HrMasterRecord } from './hr-master-provider.port.js';
import { MAX_HR_IMPORT_RECORDS } from './hr-import-validation.js';

const MAX_HR_PROVIDER_RESPONSE_BYTES = 2_000_000;
const boundedText = z.string().min(1).max(320);

const HrMasterApiRecordSchema = z.object({
  externalId: boundedText,
  firstName: boundedText,
  lastName: boundedText,
  email: z.string().email().max(320),
  role: boundedText,
  organizationUnit: boundedText,
  workTimeModel: boundedText,
  weeklyHours: z.string().min(1).max(50),
  dailyTargetHours: z.string().min(1).max(50),
  supervisorExternalId: boundedText.optional(),
  employmentStartDate: z.string().date().optional(),
  employmentEndDate: z.string().date().optional(),
});

const HrMasterApiResponseSchema = z.union([
  z.array(HrMasterApiRecordSchema).max(MAX_HR_IMPORT_RECORDS),
  z.object({
    records: z.array(HrMasterApiRecordSchema).max(MAX_HR_IMPORT_RECORDS),
  }),
]);

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60_000;

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HR_PROVIDER_RESPONSE_BYTES) {
    throw new BadGatewayException('HR master API response exceeds the size limit.');
  }
  if (!response.body) {
    throw new BadGatewayException('HR master API returned an empty response body.');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_HR_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new BadGatewayException('HR master API response exceeds the size limit.');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new BadGatewayException('HR master API returned invalid JSON.');
  }
}

function configuredUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ServiceUnavailableException('HR_MASTER_API_URL is invalid.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServiceUnavailableException('HR_MASTER_API_URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new ServiceUnavailableException('HR_MASTER_API_URL must not include credentials.');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new ServiceUnavailableException('HR_MASTER_API_URL must use HTTPS in production.');
  }

  return parsed;
}

function configuredTimeoutMs(rawTimeout: string | undefined): number {
  const parsed = Number(rawTimeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(Math.trunc(parsed), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * HTTP adapter for the optional HR master-data source.
 * It validates configuration and response shape before data enters the import pipeline.
 */
export class HttpHrMasterProvider implements HrMasterProviderPort {
  async fetchMasterRecords(): Promise<HrMasterRecord[]> {
    const url = process.env.HR_MASTER_API_URL;
    if (!url) {
      throw new ServiceUnavailableException('HR_MASTER_API_URL is not configured.');
    }

    const target = configuredUrl(url);
    const timeoutMs = configuredTimeoutMs(process.env.HR_MASTER_API_TIMEOUT_MS);
    const token = process.env.HR_MASTER_API_TOKEN;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(target, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new BadGatewayException(`HR master API returned ${response.status}.`);
      }

      const json = await readBoundedJson(response);
      const parsed = HrMasterApiResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new BadGatewayException('HR master API returned an invalid payload schema.');
      }

      const records = Array.isArray(parsed.data) ? parsed.data : parsed.data.records;
      return records.map((record) => ({
        externalId: record.externalId,
        firstName: record.firstName,
        lastName: record.lastName,
        email: record.email,
        role: record.role,
        organizationUnit: record.organizationUnit,
        workTimeModel: record.workTimeModel,
        weeklyHours: record.weeklyHours,
        dailyTargetHours: record.dailyTargetHours,
        supervisorExternalId: record.supervisorExternalId,
        employmentStartDate: record.employmentStartDate,
        employmentEndDate: record.employmentEndDate,
      }));
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new BadGatewayException('Failed to fetch HR master records.');
    } finally {
      clearTimeout(timer);
    }
  }
}
