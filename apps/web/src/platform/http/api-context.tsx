'use client';

/** Client API configuration context; stored endpoint values are convenience settings, not a trust boundary. */

import { createContext, useContext, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createApiFetch, createApiRequest, type ApiFetch, type ApiRequest } from './api-client';
import { describeApiError } from './api-error-message';
import { normalizeApiBaseUrl } from './api-url-policy';

const SESSION_ENDPOINT_SLOT = 'cq-api-base-url';
const LEGACY_SESSION_TOKEN_SLOT = 'cq-token';
const DEFAULT_API_BASE_URL = '/api';

function readSessionValue(key: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeSessionValue(key: string, value: string) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (value) {
      sessionStorage.setItem(key, value);
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {}
}

interface ApiContextValue {
  apiBaseUrl: string;
  setApiBaseUrl: (value: string) => void;
  token: string;
  setToken: (value: string) => void;
  connectionKey: string;
  apiFetch: ApiFetch;
  apiRequest: ApiRequest;
}

const ApiContext = createContext<ApiContextValue | null>(null);

interface ApiProviderProps {
  children: React.ReactNode;
}

export function ApiProvider({ children }: ApiProviderProps) {
  const tApiErrors = useTranslations('app.apiErrors');
  const [apiBaseUrl, setApiBaseUrlState] = useState(() =>
    normalizeApiBaseUrl(readSessionValue(SESSION_ENDPOINT_SLOT, DEFAULT_API_BASE_URL)),
  );
  const [token, setTokenState] = useState(() => {
    writeSessionValue(LEGACY_SESSION_TOKEN_SLOT, '');
    return '';
  });

  const value = useMemo<ApiContextValue>(() => {
    const setApiBaseUrl = (nextValue: string) => {
      const normalized = normalizeApiBaseUrl(nextValue);
      setApiBaseUrlState(normalized);
      writeSessionValue(SESSION_ENDPOINT_SLOT, normalized);

      if (normalized !== apiBaseUrl) {
        setTokenState('');
      }
    };

    const setToken = (nextValue: string) => {
      setTokenState(nextValue);
    };

    return {
      apiBaseUrl,
      setApiBaseUrl,
      token,
      setToken,
      connectionKey: `${apiBaseUrl}|${token}`,
      apiFetch: createApiFetch(apiBaseUrl, token),
      apiRequest: createApiRequest(apiBaseUrl, token, (status, payload) =>
        describeApiError(tApiErrors, status, payload),
      ),
    };
  }, [apiBaseUrl, token, tApiErrors]);

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApiContext() {
  const value = useContext(ApiContext);
  if (!value) {
    throw new Error('useApiContext must be used within ApiProvider.');
  }
  return value;
}

export function ScopedApiProvider({
  children,
  apiRequest,
}: {
  children: React.ReactNode;
  apiRequest: ApiRequest;
}) {
  const parent = useApiContext();
  const value = useMemo(() => ({ ...parent, apiRequest }), [parent, apiRequest]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}
