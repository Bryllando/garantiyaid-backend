import { PrismaPg } from "@prisma/adapter-pg";
import generatedPrismaClient from "../generated/prisma/index.js";
import { env } from "../config/env.js";

const { PrismaClient } = generatedPrismaClient;

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is required before Prisma can be initialized.");
}

const globalForPrisma = globalThis;
const adapter = new PrismaPg({ connectionString: env.databaseUrl });

const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (env.nodeEnv !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
