'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { TimeTypeListSchema, type TimeType } from '@cueq/contracts';
import { FormField } from '../../components/FormField';
import { PickerStatus } from './picker-status';
import { useNativeResource } from './use-native-resource';

function timeTypeName(type: TimeType, locale: string) {
  const name = locale === 'en' && type.nameEn ? type.nameEn : type.name;
  return `${name} (${type.code})`;
}

export function TimeTypePicker({
  label,
  value,
  onChange,
  required = false,
  emptyLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  /** Text of the empty option, e.g. "keep current"; falls back to the generic prompt. */
  emptyLabel?: string;
}) {
  const t = useTranslations('pages.nativeHr');
  const locale = useLocale();
  const [manual, setManual] = useState(false);
  const resource = useNativeResource('/v1/time-types', TimeTypeListSchema);
  const types = resource.data ?? [];
  // Without a readable catalogue the user can still type the ID.
  const fallback = resource.phase !== 'loading' && (resource.phase !== 'ready' || !types.length);
  const showManual = manual || fallback;
  return (
    <div>
      <FormField label={label} required={required}>
        {showManual ? (
          <input
            value={value}
            required={required}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <select
            value={value}
            required={required}
            disabled={resource.phase === 'loading'}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{emptyLabel ?? t('choose')}</option>
            {value && !types.some((type) => type.id === value) ? (
              <option value={value}>{value}</option>
            ) : null}
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {timeTypeName(type, locale)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {fallback ? null : (
        <button
          type="button"
          className="cq-btn-ghost cq-btn-sm"
          onClick={() => setManual((current) => !current)}
        >
          {showManual ? t('chooseTimeTypeName') : t('enterTimeTypeId')}
        </button>
      )}
      <PickerStatus phase={resource.phase} empty={!types.length} onReload={resource.load} />
    </div>
  );
}
