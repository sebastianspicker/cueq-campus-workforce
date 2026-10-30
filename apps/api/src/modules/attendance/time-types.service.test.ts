import { expect, it, vi } from 'vitest';
import { TimeTypesService } from './time-types.service.js';

it('lists only active time types ordered by code as contract-shaped DTOs', async () => {
  const at = new Date('2026-03-01T08:00:00.000Z');
  const iso = '2026-03-01T08:00:00.000Z';
  const findMany = vi.fn(async () => [
    {
      id: 'work',
      code: 'WORK',
      name: 'Arbeitszeit',
      nameEn: 'Work time',
      category: 'WORK',
      isActive: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'pause',
      code: 'PAUSE',
      name: 'Pause',
      nameEn: null,
      category: 'PAUSE',
      isActive: true,
      createdAt: at,
      updatedAt: at,
    },
  ]);
  const service = new TimeTypesService({ timeType: { findMany } } as never);

  await expect(service.listActive()).resolves.toEqual([
    {
      id: 'work',
      code: 'WORK',
      name: 'Arbeitszeit',
      nameEn: 'Work time',
      category: 'WORK',
      isActive: true,
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: 'pause',
      code: 'PAUSE',
      name: 'Pause',
      nameEn: null,
      category: 'PAUSE',
      isActive: true,
      createdAt: iso,
      updatedAt: iso,
    },
  ]);
  expect(findMany).toHaveBeenCalledWith({
    where: { isActive: true },
    orderBy: { code: 'asc' },
  });
});
