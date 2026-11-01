/** Creates monthly closing periods; global and per-unit periods exclude each other per month. */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClosingStatus } from '@cueq/database';
import { CreateClosingPeriodSchema } from '@cueq/contracts';
import { PrismaService } from '../../persistence/prisma.service.js';
import { parseRequest } from '../../platform/http/validation/zod-validation.pipe.js';
import { lockClosingPeriodWrites } from '../../platform/transactions/transaction-lock.helper.js';
import type { AuthenticatedIdentity } from '../../platform/auth/auth.types.js';
import { AuditHelper } from '../audit/public.js';
import { PersonHelper } from '../people/public.js';
import { parseMonthToRange } from './closing-period-range.js';

@Injectable()
export class ClosingPeriodCreateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PersonHelper) private readonly personHelper: PersonHelper,
    @Inject(AuditHelper) private readonly auditHelper: AuditHelper,
  ) {}

  async create(user: AuthenticatedIdentity, payload: unknown) {
    const actor = await this.personHelper.personForUser(user);
    const input = parseRequest(CreateClosingPeriodSchema, payload);
    const { from, to } = parseMonthToRange(input.month);
    const organizationUnitId = input.organizationUnitId ?? null;

    return this.prisma.$transaction(async (tx) => {
      // Serializes creation per month so the global/unit exclusion cannot race.
      await lockClosingPeriodWrites(tx, `create:${input.month}`);
      if (organizationUnitId) {
        const unit = await tx.organizationUnit.findUnique({
          where: { id: organizationUnitId },
          select: { id: true },
        });
        if (!unit) throw new NotFoundException('Organization unit not found.');
      }
      // A global request clashes with any period of the month; a unit request with its own or a global one.
      const existing = await tx.closingPeriod.findFirst({
        where: {
          periodStart: from,
          ...(organizationUnitId
            ? { OR: [{ organizationUnitId }, { organizationUnitId: null }] }
            : {}),
        },
        select: { id: true },
      });
      if (existing) throw new ConflictException('A closing period for this month already exists.');

      const created = await tx.closingPeriod.create({
        data: { organizationUnitId, periodStart: from, periodEnd: to, status: ClosingStatus.OPEN },
      });
      await this.auditHelper.appendAudit(
        {
          actorId: actor.id,
          action: 'CLOSING_PERIOD_CREATED',
          entityType: 'ClosingPeriod',
          entityId: created.id,
          after: { month: input.month, organizationUnitId, status: created.status },
        },
        tx,
      );
      return created;
    });
  }
}
