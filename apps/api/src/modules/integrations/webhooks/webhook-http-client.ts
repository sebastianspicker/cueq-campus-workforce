/** Low-level webhook transport that follows bounded redirects only after each target passes SSRF checks. */
import { request as requestHttp } from 'node:http';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as requestHttps } from 'node:https';
import { resolveWebhookDispatchTarget } from './webhook-url.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

/** Sanitized response metadata returned to webhook delivery code. */
export interface WebhookHttpResponse {
  status: number;
  body: string;
}

/** Dispatch input whose URL is revalidated at each redirect boundary. */
export interface WebhookHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects?: number;
}

function responseBody(response: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
    };

    response.on('data', (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = maxBytes - receivedBytes;
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        // The status is already known; keep the truncated body instead of failing a delivered webhook.
        chunks.push(chunk.subarray(0, remaining));
        settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    response.on('aborted', () =>
      settle(() => reject(new Error('Webhook response was interrupted.'))),
    );
    response.on('error', (error) => settle(() => reject(error)));
  });
}

function redirectLocation(response: IncomingMessage): string | null {
  if (!response.statusCode || !REDIRECT_STATUSES.has(response.statusCode)) {
    return null;
  }

  const location = response.headers.location;
  return typeof location === 'string' && location ? location : null;
}

function pinnedLookup(address: string, family: 4 | 6): RequestOptions['lookup'] {
  return (_hostname, _options, callback) => callback(null, address, family);
}

async function requestOnce(input: WebhookHttpRequest): Promise<{
  response: IncomingMessage;
  request: ClientRequest;
  cancelTimeout: () => void;
}> {
  const target = await resolveWebhookDispatchTarget(input.url);
  const requestFn = target.url.protocol === 'https:' ? requestHttps : requestHttp;

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cancelTimeout = () => clearTimeout(timer);
    const request = requestFn(
      target.url,
      {
        method: 'POST',
        headers: { ...input.headers, Host: target.url.host },
        lookup: pinnedLookup(target.address, target.family),
        family: target.family,
        servername: target.url.hostname,
      },
      (response) => resolve({ response, request, cancelTimeout }),
    );
    timer = setTimeout(() => {
      request.destroy(new Error('Webhook request timed out.'));
    }, input.timeoutMs);
    timer.unref();
    request.once('error', (error) => {
      cancelTimeout();
      reject(error);
    });
    request.end(input.body);
  });
}

/** Posts a webhook with timeout and redirect limits while preserving DNS-rebinding protections. */
export async function postWebhook(input: WebhookHttpRequest): Promise<WebhookHttpResponse> {
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let destination = input.url;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const { response, request, cancelTimeout } = await requestOnce({
      ...input,
      url: destination,
    });
    const location = redirectLocation(response);
    if (!location) {
      try {
        return {
          status: response.statusCode ?? 0,
          body: await responseBody(response, input.maxResponseBytes),
        };
      } finally {
        cancelTimeout();
      }
    }

    cancelTimeout();
    response.destroy();
    request.destroy();
    if (redirects === maxRedirects) {
      request.destroy();
      throw new Error('Webhook redirect limit exceeded.');
    }
    destination = new URL(location, destination).toString();
  }

  throw new Error('Webhook redirect limit exceeded.');
}
