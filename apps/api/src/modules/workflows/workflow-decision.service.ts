/** Workflow decision transition provider composed with feature-owned effects. */
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@cueq/database';
import type { WorkflowDecisionCommand } from '@cueq/contracts';
import { PrismaService } from '../../persistence/prisma.service.js';
import { AuditHelper } from '../audit/public.js';
import { WorkflowDelegationCrudHelper } from './workflow-delegation-crud.helper.js';
import { decideWorkflowTransition } from './workflow-runtime-decision.js';
import type { WorkflowActor, WorkflowDecisionResult } from './workflow-contracts.js';

/**
 * Owns workflow-state transitions that require owner-module side-effect ports.
 * It remains in WorkflowsModule so WorkflowRuntimeModule stays acyclic.
 */
@Injectable()
export class WorkflowDecisionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditHelper) private readonly auditHelper: AuditHelper,
    @Inject(WorkflowDelegationCrudHelper)
    private readonly delegationCrud: WorkflowDelegationCrudHelper,
  ) {}

  decide(
    actor: WorkflowActor,
    command: WorkflowDecisionCommand,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkflowDecisionResult> {
    return decideWorkflowTransition(
      {
        prisma: this.prisma,
        auditHelper: this.auditHelper,
        delegationCrud: this.delegationCrud,
      },
      actor,
      command,
      tx,
    );
  }
}
