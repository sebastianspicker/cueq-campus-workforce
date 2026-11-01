/** Defines workflow operation inputs and results shared across application collaborators. */
import type { WorkflowInstance } from '@cueq/database';
import type { Role } from '@cueq/database';
import type { WorkflowAction } from '@cueq/contracts';
import type {
  WorkflowAssignment,
  WorkflowAssignmentRequest,
} from '../../application/ports/workflow-runtime.port.js';

/** Authenticated actor context needed by workflow routing and decision helpers. */
export interface WorkflowActor {
  id: string;
  role: Role;
  organizationUnitId: string;
}

/** Inputs used to resolve an approver and effective workflow policy (defined on the port). */
export type WorkflowAssignmentInput = WorkflowAssignmentRequest;

/** Normalized routing result persisted with a newly submitted workflow (defined on the port). */
export type WorkflowAssignmentResult = WorkflowAssignment;

/** Before/after state returned by an applied workflow decision. */
export interface WorkflowDecisionResult {
  action: WorkflowAction;
  previous: WorkflowInstance;
  updated: WorkflowInstance;
}
