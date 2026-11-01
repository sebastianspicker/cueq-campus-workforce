import { afterEach, expect, it, vi } from 'vitest';
import { LifecycleRemindersService } from './lifecycle-reminders.service.js';

afterEach(() => vi.useRealTimers());
it('retries due tasks with stable recipient keys and skips tasks completed since the scan', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-29T22:30:00Z'));
  const task = {
    id: 'task',
    status: 'OPEN',
    dueDate: new Date('2026-03-30T00:00:00Z'),
    responsiblePersonId: 'person',
    responsibleGroupId: null,
  };
  const tx = { lifecycleTask: { findUnique: vi.fn().mockResolvedValue(task) } };
  const prisma = {
    lifecycleTask: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: task.id,
          dueDate: task.dueDate,
          responsiblePersonId: 'person',
          responsibleGroupId: null,
        },
      ]),
    },
    $transaction: vi.fn(async (run) => run(tx)),
  };
  const notifications = { append: vi.fn() };
  const service = new LifecycleRemindersService(prisma as never, notifications);
  await service.poll();
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  // A task already notified for its current dueDate is not processed again.
  await service.poll();
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  expect(notifications.append).toHaveBeenCalledWith(tx, [
    {
      recipientId: 'person',
      resourceType: 'LifecycleTask',
      resourceId: 'task',
      messageCode: 'TASK_DUE',
      dedupeKey: 'task-due:task:2026-03-30T00:00:00.000Z:person',
    },
  ]);
  // A new dueDate is a new reminder; a task completed since the scan is skipped.
  const moved = { ...task, id: 'task-2', dueDate: new Date('2026-03-29T00:00:00Z') };
  prisma.lifecycleTask.findMany.mockResolvedValueOnce([
    {
      id: moved.id,
      dueDate: moved.dueDate,
      responsiblePersonId: 'person',
      responsibleGroupId: null,
    },
  ]);
  tx.lifecycleTask.findUnique.mockResolvedValueOnce({ ...moved, status: 'DONE' });
  await service.poll();
  expect(notifications.append).toHaveBeenCalledTimes(1);
  expect(prisma.lifecycleTask.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ take: 100 }),
  );
});

it('does not mark a skipped task as notified and re-notifies a changed recipient', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-30T10:00:00Z'));
  const dueDate = new Date('2026-03-30T00:00:00Z');
  const row = (responsiblePersonId: string) => ({
    id: 'task',
    dueDate,
    responsiblePersonId,
    responsibleGroupId: null,
  });
  const open = (responsiblePersonId: string) => ({ ...row(responsiblePersonId), status: 'OPEN' });
  const tx = { lifecycleTask: { findUnique: vi.fn() } };
  const prisma = {
    lifecycleTask: { findMany: vi.fn().mockResolvedValue([row('person')]) },
    $transaction: vi.fn(async (run) => run(tx)),
  };
  const notifications = { append: vi.fn() };
  const service = new LifecycleRemindersService(prisma as never, notifications);
  // Early return (task no longer OPEN) must not suppress a later pass.
  tx.lifecycleTask.findUnique.mockResolvedValueOnce({ ...open('person'), status: 'DONE' });
  await service.poll();
  expect(notifications.append).not.toHaveBeenCalled();
  tx.lifecycleTask.findUnique.mockResolvedValueOnce(open('person'));
  await service.poll();
  expect(notifications.append).toHaveBeenCalledTimes(1);
  // A new responsible person gets TASK_DUE despite the unchanged dueDate.
  prisma.lifecycleTask.findMany.mockResolvedValue([row('other')]);
  tx.lifecycleTask.findUnique.mockResolvedValueOnce(open('other'));
  await service.poll();
  expect(notifications.append).toHaveBeenCalledTimes(2);
});
