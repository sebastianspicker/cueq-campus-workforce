'use client';

import { SectionCard } from '../../../components/SectionCard';
import { StatusBadge } from '../../../components/StatusBadge';
import {
  checklistVariant,
  formatInstant,
  type ClosingChecklistFinding,
  type ClosingChecklistResponse,
  type ClosingPeriod,
  type TranslationFn,
} from './closing-types';

/** Names who or what blocks a checklist item; unknown reasons fall back to the API message. */
function ChecklistFindings({
  t,
  locale,
  code,
  findings,
}: {
  t: TranslationFn;
  locale: string;
  code: string;
  findings: ClosingChecklistFinding[];
}) {
  // Reasons come from the server; only plain codes may select a catalog key.
  const localizedReason = (reason: string) =>
    /^[A-Z_]+$/u.test(reason) && t.has(`findingReasons.${reason}`)
      ? t(`findingReasons.${reason}`)
      : null;
  const remedyKey = `findingRemedies.${code}`;
  return (
    <div className="cq-closing-findings">
      <ul>
        {findings.map((finding, index) => (
          <li key={`${finding.reason}-${finding.workflowId ?? finding.bookingId ?? ''}-${index}`}>
            <strong>{finding.personName ?? finding.personId ?? t('findingUnknownPerson')}</strong>
            {': '}
            <span title={finding.message}>
              {localizedReason(finding.reason) ?? finding.message}
            </span>
            {finding.from ? (
              <small>
                {' '}
                ({formatInstant(finding.from, locale)}
                {finding.to ? ` – ${formatInstant(finding.to, locale)}` : ''})
              </small>
            ) : null}
          </li>
        ))}
      </ul>
      {t.has(remedyKey) ? <p className="cq-text-muted">{t(remedyKey)}</p> : null}
    </div>
  );
}

export function ChecklistSection({
  t,
  locale,
  checklist,
}: {
  t: TranslationFn;
  locale: string;
  checklist: ClosingChecklistResponse | null;
}) {
  return (
    <SectionCard className="cq-closing-checklist">
      <h2>{t('checklistTitle')}</h2>
      {!checklist ? (
        <p className="cq-text-muted">{t('noChecklist')}</p>
      ) : (
        <ol className="cq-closing-checklist-list">
          {checklist.items.map((item, index) => {
            const variant = checklistVariant(item);
            const statusLabel =
              variant === 'ok' ? t('fulfilled') : variant === 'muted' ? t('waiting') : t('review');
            return (
              <li key={item.code} data-variant={variant}>
                <span className="cq-closing-check-icon" aria-hidden="true">
                  {variant === 'ok' ? '✓' : variant === 'error' || variant === 'warn' ? '!' : '…'}
                </span>
                <strong data-index={`${index + 1}.`}>
                  {item.code === 'MISSING_TIME_ACCOUNTS' ? t('missingTimeAccounts') : item.label}
                </strong>
                <StatusBadge status={item.status} variant={variant} label={statusLabel} />
                <p>
                  {item.code === 'MISSING_TIME_ACCOUNTS'
                    ? t('missingTimeAccountsDetails')
                    : item.details}
                </p>
                {item.findings?.length ? (
                  <ChecklistFindings
                    t={t}
                    locale={locale}
                    code={item.code}
                    findings={item.findings}
                  />
                ) : null}
                <span className="cq-closing-row-chevron" aria-hidden="true">
                  ›
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}

export function ApprovalChainSection({
  t,
  locale,
  period,
}: {
  t: TranslationFn;
  locale: string;
  period: ClosingPeriod | null;
}) {
  if (!period) return null;
  return (
    <SectionCard className="cq-closing-evidence-card cq-closing-approval-chain">
      <h2>{t('approvalChainTitle')}</h2>
      <ol>
        <li data-complete={Boolean(period.leadApprovedAt) || undefined}>
          <span aria-hidden="true">{period.leadApprovedAt ? '✓' : ''}</span>
          <div>
            <strong>{t('teamLead')}</strong>
            <p>{period.leadApprovedAt ? t('leadGranted') : t('leadPending')}</p>
            {period.leadApprovedAt ? (
              <small>{formatInstant(period.leadApprovedAt, locale)}</small>
            ) : null}
          </div>
          <StatusBadge
            status={period.leadApprovedAt ? 'COMPLETED' : 'PENDING'}
            label={period.leadApprovedAt ? t('completed') : t('pending')}
          />
        </li>
        <li data-complete={Boolean(period.hrApprovedAt) || undefined}>
          <span aria-hidden="true">{period.hrApprovedAt ? '✓' : ''}</span>
          <div>
            <strong>{t('humanResources')}</strong>
            <p>{period.hrApprovedAt ? t('hrGranted') : t('hrPending')}</p>
            {period.hrApprovedAt ? (
              <small>{formatInstant(period.hrApprovedAt, locale)}</small>
            ) : (
              <small className="cq-warn">{t('nextStep')}</small>
            )}
          </div>
          <StatusBadge
            status={period.hrApprovedAt ? 'COMPLETED' : 'PENDING'}
            label={period.hrApprovedAt ? t('completed') : t('pending')}
          />
        </li>
      </ol>
    </SectionCard>
  );
}
