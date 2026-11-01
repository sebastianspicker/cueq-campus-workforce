/** Date-triggered task reminders with finite reads and durable recipient deduplication. */
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../persistence/prisma.service.js';
import {
  INBOX_NOTIFICATIONS_PORT,
  type InboxNotificationsPort,
} from '../../application/ports/inbox-notifications.port.js';
import { lifecycleToday } from './lifecycle-date.js';

@Injectable()
export class LifecycleRemindersService implements OnApplicationBootstrap {
  private running = false;
  private cursor: string | undefined;
  // Tasks already notified for their current dueDate and recipient source; avoids re-running three queries per task every poll.
  // shortcut: per-process memory, cleared when large; a restart redoes one idempotent pass.
  private readonly notified = new Set<string>();
  private readonly logger = new Logger(LifecycleRemindersService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(INBOX_NOTIFICATIONS_PORT) private readonly notifications: InboxNotificationsPort,
  ) {}
  onApplicationBootstrap() {
    void this.poll();
  }
  @Interval(30_000)
  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const today = lifecycleToday();
      const tasks = await this.prisma.lifecycleTask.findMany({
        where: {
          status: 'OPEN',
          dueDate: { lte: today },
          ...(this.cursor ? { id: { gt: this.cursor } } : {}),
        },
        select: { id: true, dueDate: true, responsiblePersonId: true, responsibleGroupId: true },
        orderBy: { id: 'asc' },
        take: 100,
      });
      if (this.notified.size > 10_000) this.notified.clear();
      for (const item of tasks) {
        const key = `${item.id}:${item.dueDate.toISOString()}:${item.responsiblePersonId ?? `group:${item.responsibleGroupId}`}`;
        if (this.notified.has(key)) continue;
        const appended = await this.prisma.$transaction(async (tx) => {
          const task = await tx.lifecycleTask.findUnique({ where: { id: item.id } });
          if (!task || task.status !== 'OPEN' || task.dueDate > today) return false;
          const recipients = task.responsiblePersonId
            ? [task.responsiblePersonId]
            : (
                await tx.taskGroupMember.findMany({
                  where: { groupId: task.responsibleGroupId ?? '' },
                  select: { personId: true },
                  take: 101,
                })
              ).map((member) => member.personId);
          if (recipients.length > 100)
            throw new Error('Task group exceeds configured recipient bound');
          await this.notifications.append(
            tx,
            recipients.map((recipientId) => ({
              recipientId,
              resourceType: 'LifecycleTask',
              resourceId: task.id,
              messageCode: 'TASK_DUE',
              dedupeKey: `task-due:${task.id}:${task.dueDate.toISOString()}:${recipientId}`,
            })),
          );
          return true;
        });
        if (appended) this.notified.add(key);
      }
      this.cursor = tasks.length === 100 ? tasks.at(-1)?.id : undefined;
    } catch {
      this.logger.warn('Task reminders will retry after a storage failure.');
    } finally {
      this.running = false;
    }
  }
}
