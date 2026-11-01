/** Maps persisted absences to the stable API response contract. */
import { Role, type Absence } from '@cueq/database';
import type { Absence as AbsenceResponse } from '@cueq/contracts';

/** Notes are private to the absence owner and HR; ADMIN and team leads do not see them. */
export function canSeeAbsenceNote(
  user: { role: Role },
  actorPersonId: string,
  absence: Pick<Absence, 'personId'>,
): boolean {
  return user.role === Role.HR || absence.personId === actorPersonId;
}

export function toAbsenceResponse(absence: Absence, includeNote: boolean): AbsenceResponse {
  return {
    id: absence.id,
    personId: absence.personId,
    assignmentId: absence.assignmentId,
    type: absence.type,
    startDate: absence.startDate.toISOString().slice(0, 10),
    endDate: absence.endDate.toISOString().slice(0, 10),
    days: absence.days.toNumber(),
    status: absence.status,
    note: includeNote ? absence.note : null,
    createdAt: absence.createdAt.toISOString(),
    updatedAt: absence.updatedAt.toISOString(),
  };
}
