import { randomUUID } from 'node:crypto';
import { staffImportDatabase } from './staffImportDatabase.js';

export function barangayImportDatabase() {
  const db = staffImportDatabase();
  db.barangay.findMany = async () => structuredClone(db.state.barangays);
  db.barangay.create = async ({ data }) => {
    if (data.barangayCode && db.state.barangays.some(row => row.barangayCode === data.barangayCode)) throw Object.assign(new Error('Duplicate code'), { code: 'P2002' });
    const row = { barangayId: randomUUID(), isActive: true, ...data, barangayCode: data.barangayCode ?? null };
    db.state.barangays.push(row);
    return structuredClone(row);
  };
  return db;
}
