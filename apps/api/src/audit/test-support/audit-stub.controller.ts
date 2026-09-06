/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { getPatientActor } from '../../auth/patient-actor';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { Audited } from '../audited.decorator';
import { stageAuditEntry } from '../audit-recorder';

/**
 * TEST SCAFFOLDING — not a real endpoint and not a real PHI table.
 *
 * P1.S5 ships the audit interceptor and threshold service *before* any real
 * PHI write endpoint exists (P2.S1a owns the first one, observations). This
 * controller exists only to give `AuditInterceptor`, `route-guard-
 * coverage.spec.ts`, and `audit.integration.spec.ts` a `@Audited()` route to
 * exercise end to end — a synthetic in-memory "widget" entity with no
 * clinical meaning, so nothing here should be mistaken for, or extended
 * into, a real feature. Delete this file (and its module) in the same
 * change that P2.S1a's real observation controller lands, rather than
 * growing it into one — same convention `PatientStubController`'s own doc
 * comment states for itself.
 */
@ApiTags('audit-stub')
@Controller('audit-stub/widgets')
@UseGuards(JwtAuthGuard)
export class AuditStubController {
  // In-memory only, keyed by the caller's patient id — this is scaffolding,
  // not a repository, and intentionally does not survive a process restart.
  private readonly widgetsByPatient = new Map<string, Map<string, unknown>>();

  @Post()
  @Audited()
  @ApiBearerAuth('patient-oidc')
  @ApiOperation({
    summary: 'TEST SCAFFOLDING — creates a synthetic audited widget. Not a real endpoint.',
  })
  create(@Req() request: Request, @Body() body: Record<string, unknown>): { id: string } {
    const patientId = getPatientActor(request).id;
    const id = randomUUID();
    const afterValue = { ...body };

    this.widgetsFor(patientId).set(id, afterValue);

    stageAuditEntry(request, {
      actorType: 'PATIENT',
      actorId: patientId,
      action: 'CREATE',
      entityType: 'audit_stub_widget',
      entityId: id,
      reasonCode: 'direct_write',
      afterValue,
    });

    return { id };
  }

  @Get(':id')
  @ApiBearerAuth('patient-oidc')
  @ApiOperation({
    summary:
      'TEST SCAFFOLDING — reads back a synthetic widget. Not audited: reads are not PHI mutations.',
  })
  read(@Req() request: Request, @Param('id') id: string): { id: string; value: unknown } {
    const patientId = getPatientActor(request).id;
    const value = this.widgetsFor(patientId).get(id);
    if (value === undefined) {
      throw new NotFoundException({ code: 'AUDIT_STUB_WIDGET_NOT_FOUND' });
    }
    return { id, value };
  }

  @Put(':id')
  @Audited()
  @ApiBearerAuth('patient-oidc')
  @ApiOperation({
    summary: 'TEST SCAFFOLDING — updates a synthetic audited widget. Not a real endpoint.',
  })
  update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): { id: string } {
    const patientId = getPatientActor(request).id;
    const widgets = this.widgetsFor(patientId);
    const beforeValue = widgets.get(id);
    if (beforeValue === undefined) {
      throw new NotFoundException({ code: 'AUDIT_STUB_WIDGET_NOT_FOUND' });
    }

    const afterValue = { ...body };
    widgets.set(id, afterValue);

    stageAuditEntry(request, {
      actorType: 'PATIENT',
      actorId: patientId,
      action: 'UPDATE',
      entityType: 'audit_stub_widget',
      entityId: id,
      reasonCode: 'direct_write',
      beforeValue,
      afterValue,
    });

    return { id };
  }

  @Delete(':id')
  @Audited()
  @ApiBearerAuth('patient-oidc')
  @ApiOperation({
    summary: 'TEST SCAFFOLDING — deletes a synthetic audited widget. Not a real endpoint.',
  })
  remove(@Req() request: Request, @Param('id') id: string): { id: string } {
    const patientId = getPatientActor(request).id;
    const widgets = this.widgetsFor(patientId);
    const beforeValue = widgets.get(id);
    if (beforeValue === undefined) {
      throw new NotFoundException({ code: 'AUDIT_STUB_WIDGET_NOT_FOUND' });
    }
    widgets.delete(id);

    stageAuditEntry(request, {
      actorType: 'PATIENT',
      actorId: patientId,
      action: 'DELETE',
      entityType: 'audit_stub_widget',
      entityId: id,
      reasonCode: 'direct_write',
      beforeValue,
    });

    return { id };
  }

  private widgetsFor(patientId: string): Map<string, unknown> {
    let widgets = this.widgetsByPatient.get(patientId);
    if (!widgets) {
      widgets = new Map();
      this.widgetsByPatient.set(patientId, widgets);
    }
    return widgets;
  }
}
