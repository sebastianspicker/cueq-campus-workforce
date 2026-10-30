/** Lists the configured time types that can be selected on new bookings. */
import { Inject, Injectable } from '@nestjs/common';
import { TimeTypeListSchema } from '@cueq/contracts';
import { PrismaService } from '../../persistence/prisma.service.js';

@Injectable()
export class TimeTypesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listActive(): Promise<unknown> {
    const rows = await this.prisma.timeType.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
    });
    return TimeTypeListSchema.parse(
      rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        nameEn: row.nameEn,
        category: row.category,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    );
  }
}
