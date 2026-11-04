import type { MediaStore } from '../../media/store.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerAdminAuditRoutes } from './audit.js';
import { registerAdminCategoryRoutes } from './categories.js';
import { registerAdminCustomerRoutes } from './customers.js';
import { registerAdminDashboardRoutes } from './dashboard.js';
import { registerAdminDeliveryRoutes } from './delivery.js';
import { registerAdminInventoryRoutes } from './inventory.js';
import { registerAdminOrderRoutes } from './orders.js';
import { registerAdminProductRoutes } from './products.js';
import { registerAdminRefundRoutes } from './refunds.js';
import { registerAdminReportRoutes } from './reports.js';
import { registerAdminReturnRoutes } from './returns.js';
import { registerAdminSettingsRoutes } from './settings.js';
import { registerAdminStaffRoutes } from './staff.js';

/** Every admin route checks the caller's role itself (admin or operator) before touching data. */
export async function registerAdminRoutes(app: FastifyInstance, pool: Pool, deps: { onlinePaymentsAvailable: () => boolean; media: MediaStore }): Promise<void> {
  await registerAdminDashboardRoutes(app, pool);
  await registerAdminProductRoutes(app, pool, { media: deps.media });
  await registerAdminCategoryRoutes(app, pool, { media: deps.media });
  await registerAdminOrderRoutes(app, pool);
  await registerAdminReturnRoutes(app, pool);
  await registerAdminRefundRoutes(app, pool);
  await registerAdminCustomerRoutes(app, pool);
  await registerAdminAuditRoutes(app, pool);
  await registerAdminInventoryRoutes(app, pool);
  await registerAdminDeliveryRoutes(app, pool);
  await registerAdminReportRoutes(app, pool);
  await registerAdminSettingsRoutes(app, pool, deps);
  await registerAdminStaffRoutes(app, pool);
}
