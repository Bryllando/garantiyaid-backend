import { staffImportDatabase } from './staffImportDatabase.js';

export function programImportDatabase() {
  const db = staffImportDatabase();
  db.state.programs = [];
  db.programImportJob = db.staffImportJob;
  db.programImportBatch = db.staffImportBatch;
  db.program = {
    findMany: async ({ where }) => structuredClone(db.state.programs.filter(row => where.programCode.in.some(code => code.toLowerCase() === row.programCode.toLowerCase()))),
    create: async ({ data }) => {
      if (db.state.programs.some(row => row.programCode === data.programCode)) throw Object.assign(new Error('Duplicate'), { code: 'P2002' });
      const row = { programId: `program-${db.state.programs.length + 1}`, ...data };
      db.state.programs.push(row);
      return structuredClone(row);
    },
  };
  return db;
}
