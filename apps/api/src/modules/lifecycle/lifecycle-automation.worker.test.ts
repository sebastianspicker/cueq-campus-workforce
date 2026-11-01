import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleAutomationWorker } from './lifecycle-automation.worker.js';

type RuleFixture = {
  id: string;
  templateId: string;
  organizationUnitId: string;
  trigger: 'APPOINTMENT_START' | 'APPOINTMENT_END' | 'DATE';
  triggerDate: Date | null;
  offsetDays: number;
  conditions: Record<string, string>;
  authorizedById: string;
  createdAt: Date;
};

const rule: RuleFixture = {
  id: 'rule-1',
  templateId: 'template-1',
  organizationUnitId: 'ou-1',
  trigger: 'APPOINTMENT_START',
  triggerDate: null,
  offsetDays: 0,
  conditions: {},
  authorizedById: 'actor-1',
  createdAt: new Date('2026-09-01T13:00:00.000Z'),
};

function setup(overrides: Partial<typeof rule> = {}) {
  const activeRule = { ...rule, ...overrides };
  const assignment = {
    id: 'assignment-1',
    personId: 'person-1',
    sourceSystem: 'HR',
    employmentStartDate: new Date('2026-09-03T00:00:00.000Z'),
    employmentEndDate: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
  const prisma = {
    lifecycleAutomationRule: { findMany: vi.fn().mockResolvedValue([activeRule]) },
    employmentAssignment: { findMany: vi.fn().mockResolvedValue([assignment]) },
    lifecycleInstance: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const assignments = {
    resolveInterval: vi.fn().mockResolvedValue({
      organizationUnitId: 'ou-1',
      term: { employmentGroupId: 'group-1' },
    }),
  };
  const instances = { activate: vi.fn().mockResolvedValue({ id: 'instance-1' }) };
  return {
    worker: new LifecycleAutomationWorker(
      prisma as never,
      assignments as never,
      instances as never,
    ),
    prisma,
    instances,
  };
}

describe('LifecycleAutomationWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovers an eligible appointment date missed since rule creation', async () => {
    const { worker, instances } = setup();

    await worker.runOnce();

    expect(instances.activate).toHaveBeenCalledWith(
      'actor-1',
      expect.objectContaining({
        eventKey: 'automation:rule-1:assignment-1:2026-09-03',
        baseDate: '2026-09-03',
      }),
      { automationRuleId: 'rule-1' },
    );
  });

  it('does not scan assignments for a DATE trigger due before the rule existed', async () => {
    const { worker, prisma, instances } = setup({
      trigger: 'DATE',
      triggerDate: new Date('2026-08-15T00:00:00.000Z'),
    });

    await worker.runOnce();

    expect(prisma.employmentAssignment.findMany).not.toHaveBeenCalled();
    expect(instances.activate).not.toHaveBeenCalled();
  });

  it('skips a candidate whose exact event key exists and activates a changed base date', async () => {
    const { worker, prisma, instances } = setup();
    prisma.lifecycleInstance.findMany.mockResolvedValue([
      { eventKey: 'automation:rule-1:assignment-1:2026-09-03' },
    ]);

    await worker.runOnce();

    expect(prisma.lifecycleInstance.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.lifecycleInstance.findMany).toHaveBeenCalledWith({
      where: {
        templateId: 'template-1',
        eventKey: { in: ['automation:rule-1:assignment-1:2026-09-03'] },
      },
      select: { eventKey: true },
    });
    expect(instances.activate).not.toHaveBeenCalled();

    // The start date moved: the old instance has a different key, so the rule fires again.
    prisma.employmentAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        personId: 'person-1',
        sourceSystem: 'HR',
        employmentStartDate: new Date('2026-09-04T00:00:00.000Z'),
        employmentEndDate: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    await worker.runOnce();
    expect(instances.activate).toHaveBeenCalledWith(
      'actor-1',
      expect.objectContaining({ eventKey: 'automation:rule-1:assignment-1:2026-09-04' }),
      { automationRuleId: 'rule-1' },
    );
  });
});
