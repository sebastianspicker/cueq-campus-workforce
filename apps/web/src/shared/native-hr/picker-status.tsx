'use client';

import { useTranslations } from 'next-intl';
import type { NativePhase } from './use-native-resource';

/** Loading, empty and failure lines shared by the lookup pickers. */
export function PickerStatus({
  phase,
  empty,
  onReload,
}: {
  phase: NativePhase;
  empty: boolean;
  onReload: () => unknown;
}) {
  const t = useTranslations('pages.nativeHr');
  return (
    <>
      {phase === 'loading' ? <p role="status">{t('loading')}</p> : null}
      {phase === 'ready' && empty ? <p>{t('empty')}</p> : null}
      {phase !== 'loading' && phase !== 'ready' ? <p role="alert">{t(phase)}</p> : null}
      {phase === 'error' ? (
        <button type="button" onClick={() => void onReload()}>
          {t('reload')}
        </button>
      ) : null}
    </>
  );
}
