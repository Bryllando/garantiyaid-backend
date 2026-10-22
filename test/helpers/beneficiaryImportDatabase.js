import { staffImportDatabase } from './staffImportDatabase.js';

const match = (row, where) => Object.entries(where).every(([key, value]) => {
  if (key === 'OR') return value.some(item => match(row, item));
  if (value instanceof Date) return new Date(row[key]).getTime() === value.getTime();
  if (value?.in) return value.in.some(item => value.mode === 'insensitive' ? String(item).toLowerCase() === String(row[key]).toLowerCase() : item === row[key]);
  if (value?.equals !== undefined) return value.mode === 'insensitive' ? value.equals.toLowerCase() === row[key]?.toLowerCase() : row[key] === value.equals;
  return (row[key] ?? null) === value;
});
export function beneficiaryImportDatabase() {
  const db = staffImportDatabase();
  db.state.beneficiaries = [];
  db.state.programs = [];
  db.state.enrollments = [];
  db.beneficiaryImportJob = db.staffImportJob;
  db.beneficiaryImportBatch = db.staffImportBatch;
  db.beneficiary = {
    findMany: async ({ where }) => structuredClone(db.state.beneficiaries.filter(row => match(row, where))),
    create: async ({ data }) => {
      if (db.state.beneficiaries.some(row => (data.email && row.email === data.email) || (data.philsysNumber && row.philsysNumber === data.philsysNumber))) throw Object.assign(new Error('Duplicate'), { code: 'P2002' });
      const row = { beneficiaryId: `beneficiary-${db.state.beneficiaries.length + 1}`, ...data };
      db.state.beneficiaries.push(row);
      return structuredClone(row);
    },
  };
  db.program = { findMany: async ({ where }) => structuredClone(db.state.programs.filter(row => match(row, where))) };
  db.enrollment = { create: async ({ data }) => { const row = { enrollmentId: `enrollment-${db.state.enrollments.length + 1}`, ...data }; db.state.enrollments.push(row); return structuredClone(row); } };
  return db;
}
