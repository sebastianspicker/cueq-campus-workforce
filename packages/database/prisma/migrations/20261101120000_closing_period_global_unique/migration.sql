-- PostgreSQL treats NULL organizationUnitId values as distinct, so the composite unique key
-- allows several global periods per month. Prisma cannot express partial indexes.
CREATE UNIQUE INDEX "closing_periods_global_period_start_key" ON "closing_periods" ("periodStart") WHERE "organizationUnitId" IS NULL;
