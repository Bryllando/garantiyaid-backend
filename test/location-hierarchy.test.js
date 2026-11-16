import test from 'node:test';
import assert from 'node:assert/strict';
import { createBarangaySchema } from '../src/modules/barangays/barangay.schemas.js';
import { isRegisteredServiceArea } from '../src/modules/barangays/barangay.service.js';
import { enrollmentListQuerySchema } from '../src/modules/enrollments/enrollment.schemas.js';
import { beneficiaryListQuerySchema } from '../src/modules/beneficiaries/beneficiary.schemas.js';
import { validateBeneficiaryImport } from '../src/modules/beneficiaries/beneficiaryImport.service.js';
import { beneficiaryImportDatabase } from './helpers/beneficiaryImportDatabase.js';

test('managed areas reject duplicate names within a parent and permit identical names under another parent', () => {
  const place = { barangayName: 'North', city: 'Test City', province: 'Test Province' };
  assert.equal(createBarangaySchema.safeParse({ ...place, serviceAreas: ['Sitio Riverside', ' sitio riverside '] }).success, false);
  const north = createBarangaySchema.parse({ ...place, serviceAreas: ['Sitio Riverside', 'Purok North'] });
  const south = createBarangaySchema.parse({ ...place, barangayName: 'South', serviceAreas: ['Sitio Riverside'] });
  assert.equal(isRegisteredServiceArea(south, 'SITIO RIVERSIDE'), true);
  assert.equal(isRegisteredServiceArea(south, 'Purok North'), false);
  assert.equal(isRegisteredServiceArea(north, null), false);
});
test('exact beneficiary enrollment and location filters validate their trust boundaries', () => {
  const beneficiaryId = '11111111-1111-4111-8111-111111111111';
  assert.equal(enrollmentListQuerySchema.parse({ beneficiaryId }).beneficiaryId, beneficiaryId);
  assert.equal(enrollmentListQuerySchema.safeParse({ beneficiaryId: 'untrusted' }).success, false);
  assert.equal(beneficiaryListQuerySchema.parse({ city: ' Test City ', sitioPurok: 'Sitio Riverside' }).city, 'Test City');
});
test('import keeps unknown location text without silently confirming it and rejects a conflicting City', async () => {
  const db = beneficiaryImportDatabase();
  const barangayId = '11111111-1111-4111-8111-111111111111';
  db.state.barangays.push({ barangayId, isActive: true, barangayName: 'North', city: 'Test City', serviceAreas: ['Sitio Riverside'] });
  const actor = { role: 'SYSTEM_ADMIN', isActive: true };
  const row = { sourceRow: 2, firstName: 'Synthetic', lastName: 'Location', birthDate: '1990-01-01', sex: 'FEMALE', address: 'One Street', barangayId, city: 'Test City', sitioPurok: 'Legacy unknown text' };
  const reviewed = await validateBeneficiaryImport([row], actor, db);
  assert.equal(reviewed.validCount, 1); assert.equal(reviewed.rows[0].warnings.length, 1);
  assert.equal(reviewed.rows[0].record.sitioPurok, row.sitioPurok); assert.equal(reviewed.rows[0].record.city, undefined);
  const wrongCity = await validateBeneficiaryImport([{ ...row, city: 'Different City' }], actor, db);
  assert.equal(wrongCity.invalidCount, 1); assert.match(wrongCity.rows[0].issues.join(' '), /City does not match/);
  const missing = await validateBeneficiaryImport([{ ...row, sitioPurok: '' }], actor, db);
  assert.equal(missing.validCount, 1); assert.equal(missing.rows[0].record.sitioPurok, null);
});
