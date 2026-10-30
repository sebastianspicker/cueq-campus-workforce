/** Exposes the active time-type catalogue to authenticated callers. */
import { Controller, Get, Inject } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Authenticated } from '../../platform/auth/decorators/authenticated.decorator.js';
import { TimeTypesService } from './time-types.service.js';

@ApiTags('time-types')
@ApiBearerAuth()
@Controller('v1/time-types')
export class TimeTypesController {
  constructor(@Inject(TimeTypesService) private readonly timeTypes: TimeTypesService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'List active time types ordered by code' })
  list() {
    return this.timeTypes.listActive();
  }
}
