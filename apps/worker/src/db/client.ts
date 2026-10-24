import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";
import type { Db } from "./types.js";

/**
 * Driver-agnostic database handle. `any` for the query-result HKT so both
 * the neon-http production driver, the node-postgres driver, and the pglite
 * test driver are assignable — adapters only use the query-builder surface,
 * which is identical across drivers.
 */
export type { Db } from "./types.js";

let _db: Db | null = null;

/**
 * Lazily-created singleton. Uses the fetch-based neon() driver by default
 * (safe in Vercel serverless functions and WDK step bundles), or a standard
 * node-postgres Pool when DATABASE_DRIVER=postgres is set for self-hosted /
 * Docker deployments.
 */
export function getDb(): Db {
  if (!_db) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("Invalid environment variables:\n  DATABASE_URL: Required");
    }
    if (process.env.DATABASE_DRIVER === "postgres") {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      _db = drizzleNodePg({ client: pool, schema });
    } else {
      _db = drizzleNeon({ client: neon(databaseUrl), schema });
    }
  }
  return _db;
}
