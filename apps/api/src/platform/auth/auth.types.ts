/** Trusted identity shape attached by authentication guards and consumed by authorization boundaries. */
import type { Role } from '@cueq/database';

/** Data an identity provider has cryptographically verified; carries no authorization decisions. */
export interface VerifiedIdentity {
  subject: string;
  email: string;
  claims: Record<string, unknown>;
}

/** Verified identity enriched with the role and unit stored in the database. */
export interface AuthenticatedIdentity extends VerifiedIdentity {
  role: Role;
  personId?: string;
  organizationUnitId?: string;
}
