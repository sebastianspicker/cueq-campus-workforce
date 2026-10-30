'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PersonnelDirectoryPageSchema, type PersonnelDirectoryItem } from '@cueq/contracts';
import { FormField } from '../../components/FormField';
import { PickerStatus } from './picker-status';
import { useNativeCollection } from './use-native-resource';

function PersonOptions({ people, value }: { people: PersonnelDirectoryItem[]; value: string }) {
  const t = useTranslations('pages.nativeHr');
  return (
    <>
      <option value="">{t('choose')}</option>
      {value && !people.some((person) => person.id === value) ? (
        <option value={value}>{value}</option>
      ) : null}
      {people.map((person) => (
        <option key={person.id} value={person.id}>
          {`${person.lastName}, ${person.firstName}`}
        </option>
      ))}
    </>
  );
}

export function PersonPicker({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const t = useTranslations('pages.nativeHr');
  const [manual, setManual] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const resource = useNativeCollection(
    search ? `/v1/personnel?search=${encodeURIComponent(search)}` : '/v1/personnel',
    PersonnelDirectoryPageSchema,
  );
  const people = resource.data?.items ?? [];
  // The directory is capability-scoped: when it is closed or has nothing to offer, ask for the ID.
  const fallback =
    resource.phase !== 'loading' && (resource.phase !== 'ready' || (!people.length && !search));
  const showManual = manual || fallback;
  return (
    <div>
      {showManual ? null : (
        <FormField label={t('searchPerson')}>
          <input
            type="search"
            value={query}
            maxLength={100}
            onChange={(event) => setQuery(event.target.value)}
          />
        </FormField>
      )}
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
            <PersonOptions people={people} value={value} />
          </select>
        )}
      </FormField>
      {fallback ? null : (
        <button
          type="button"
          className="cq-btn-ghost cq-btn-sm"
          onClick={() => setManual((current) => !current)}
        >
          {showManual ? t('choosePersonName') : t('enterPersonId')}
        </button>
      )}
      <PickerStatus phase={resource.phase} empty={!people.length} onReload={resource.load} />
      {resource.data?.nextCursor ? (
        <button
          type="button"
          disabled={resource.phase === 'loading'}
          onClick={() => void resource.more()}
        >
          {t('more')}
        </button>
      ) : null}
    </div>
  );
}
