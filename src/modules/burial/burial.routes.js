import { Router } from 'express';
import { authenticateStaff } from '../../middleware/authenticate.js';
import { authorizeRoles } from '../../middleware/authorize.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import { createBurialSchema, editBurialSchema, burialIdSchema, burialListSchema, burialActionSchema } from './burial.schemas.js';
import { listBurialReferrals, getBurialReferral, mutateBurialReferral } from './burial.controller.js';

const routes = Router();
routes.use(authenticateStaff, authorizeRoles('SYSTEM_ADMIN', 'DSWD_STAFF', 'BARANGAY_FACILITATOR'));
routes.get('/', validateQuery(burialListSchema), listBurialReferrals);
routes.post('/', validateBody(createBurialSchema), mutateBurialReferral);
routes.get('/:referralId', validateParams(burialIdSchema), getBurialReferral);
routes.patch('/:referralId', validateParams(burialIdSchema), validateBody(editBurialSchema), mutateBurialReferral);
routes.post('/:referralId/actions', validateParams(burialIdSchema), validateBody(burialActionSchema), mutateBurialReferral);
export default routes;
