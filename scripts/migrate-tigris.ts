#!/usr/bin/env npx tsx
/**
 * Migrate Tigris data from shared bucket to per-tenant buckets.
 *
 * Copies objects from the old shared bucket (long-rain-9729) where each tenant's
 * data lives under a {TEAM_ID}/ prefix, into the per-tenant bucket (fly_app_name)
 * preserving the same key structure.
 *
 * Usage:
 *   # Set required env vars (or use .env file in this directory)
 *   export DATABASE_URL="postgres://..."
 *   export AWS_ACCESS_KEY_ID="..."
 *   export AWS_SECRET_ACCESS_KEY="..."
 *   export AWS_ENDPOINT_URL_S3="https://fly.storage.tigris.dev"
 *
 *   # Dry run (default) — shows what would be copied
 *   npx tsx scripts/migrate-tigris.ts
 *
 *   # Execute migration
 *   npx tsx scripts/migrate-tigris.ts --execute
 *
 *   # Migrate a single tenant
 *   npx tsx scripts/migrate-tigris.ts --execute --tenant T0AQH18QY84
 *
 * Prerequisites:
 *   - Credentials must have read access to the old shared bucket
 *     AND write access to the per-tenant buckets.
 *   - If using per-bucket credentials, use --source-key/--source-secret
 *     for the old bucket and the default AWS_* vars for the new buckets.
 *   - Verify buckets exist first: fly storage list -o <org>
 *
 * Install deps (from repo root):
 *   pnpm add -D @aws-sdk/client-s3 postgres
 */

import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";

// ── Config ──────────────────────────────────────────────────────

const OLD_BUCKET = process.env.OLD_BUCKET ?? "long-rain-9729";
const ENDPOINT = process.env.AWS_ENDPOINT_URL_S3 ?? "https://fly.storage.tigris.dev";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const DATABASE_URL = requireEnv("DATABASE_URL");
const AWS_ACCESS_KEY_ID = requireEnv("AWS_ACCESS_KEY_ID");
const AWS_SECRET_ACCESS_KEY = requireEnv("AWS_SECRET_ACCESS_KEY");

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const tenantFilter = args.includes("--tenant") ? args[args.indexOf("--tenant") + 1] : null;

// Separate credentials for source bucket (optional)
const sourceKey = args.includes("--source-key") ? args[args.indexOf("--source-key") + 1] : null;
const sourceSecret = args.includes("--source-secret")
  ? args[args.indexOf("--source-secret") + 1]
  : null;

// S3 client for destination (per-tenant buckets) — uses default AWS_* credentials
const destS3 = new S3Client({
  endpoint: ENDPOINT,
  region: "auto",
  forcePathStyle: true,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// S3 client for source (old shared bucket) — uses separate credentials if provided
const sourceS3 =
  sourceKey && sourceSecret
    ? new S3Client({
        endpoint: ENDPOINT,
        region: "auto",
        forcePathStyle: true,
        credentials: { accessKeyId: sourceKey, secretAccessKey: sourceSecret },
      })
    : destS3;

// ── Helpers ─────────────────────────────────────────────────────

async function listAllKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of result.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function bucketExists(client: S3Client, bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

async function copyObject(sourceKey: string, destBucket: string, destKey: string): Promise<void> {
  // Try S3 CopyObject first (server-side copy, faster)
  try {
    await destS3.send(
      new CopyObjectCommand({
        CopySource: `${OLD_BUCKET}/${sourceKey}`,
        Bucket: destBucket,
        Key: destKey,
      }),
    );
    return;
  } catch {
    // CopyObject may fail if credentials differ between buckets — fall back to GET + PUT
  }

  // Fallback: download from source, upload to destination
  const getResult = await sourceS3.send(
    new GetObjectCommand({ Bucket: OLD_BUCKET, Key: sourceKey }),
  );
  const body = await getResult.Body?.transformToByteArray();
  if (!body) throw new Error(`Empty body for ${sourceKey}`);

  await destS3.send(
    new PutObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      Body: body,
      ContentType: getResult.ContentType,
    }),
  );
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Tigris Migration: ${OLD_BUCKET} → per-tenant buckets`);
  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN (use --execute to apply)"}`);
  console.log(`${"=".repeat(60)}\n`);

  // 1. Verify source bucket
  const sourceExists = await bucketExists(sourceS3, OLD_BUCKET);
  if (!sourceExists) {
    console.error(`Source bucket "${OLD_BUCKET}" not found or not accessible`);
    process.exit(1);
  }
  console.log(`Source bucket "${OLD_BUCKET}" ✓`);

  // 2. Get tenant → bucket mappings from database
  const sql = postgres(DATABASE_URL);

  try {
    const query = tenantFilter
      ? sql`SELECT id, name, fly_app_name FROM tenants WHERE status = 'active' AND fly_app_name IS NOT NULL AND id = ${tenantFilter}`
      : sql`SELECT id, name, fly_app_name FROM tenants WHERE status = 'active' AND fly_app_name IS NOT NULL`;

    const tenants = await query;

    if (tenants.length === 0) {
      console.log("No active tenants with fly_app_name found.");
      return;
    }
    console.log(`Found ${tenants.length} tenant(s) to migrate\n`);

    // 3. Migrate each tenant
    let totalCopied = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (const tenant of tenants) {
      const tenantId = tenant.id;
      const destBucket = tenant.fly_app_name;
      const prefix = `${tenantId}/`;

      console.log(`── ${tenant.name} (${tenantId}) → ${destBucket}`);

      // Check destination bucket exists
      const destExists = await bucketExists(destS3, destBucket);
      if (!destExists) {
        console.log(`   SKIP: destination bucket "${destBucket}" does not exist or not accessible`);
        console.log(
          `   Fix:  fly ext storage destroy ${destBucket} -a ${destBucket}  # remove broken add-on`,
        );
        console.log(`         fly storage create -a ${destBucket} -n ${destBucket} -o <org>`);
        totalSkipped++;
        continue;
      }

      // List objects in old bucket under this tenant's prefix
      const keys = await listAllKeys(sourceS3, OLD_BUCKET, prefix);
      if (keys.length === 0) {
        console.log(`   No objects found in ${OLD_BUCKET}/${prefix}`);
        continue;
      }
      console.log(`   Found ${keys.length} object(s) to copy`);

      if (!execute) {
        // Dry run — just show what would be copied
        for (const key of keys.slice(0, 10)) {
          console.log(`   → ${key}`);
        }
        if (keys.length > 10) {
          console.log(`   ... and ${keys.length - 10} more`);
        }
        continue;
      }

      // Execute: copy objects
      let copied = 0;
      let failed = 0;
      for (const key of keys) {
        try {
          await copyObject(key, destBucket, key);
          copied++;
          if (copied % 50 === 0) {
            console.log(`   Copied ${copied}/${keys.length}...`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`   FAIL: ${key} — ${msg}`);
          failed++;
        }
      }

      console.log(`   Done: ${copied} copied, ${failed} failed`);
      totalCopied += copied;
      totalFailed += failed;
    }

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    if (execute) {
      console.log(
        `Migration complete: ${totalCopied} copied, ${totalFailed} failed, ${totalSkipped} skipped`,
      );
    } else {
      console.log(`Dry run complete. Use --execute to apply.`);
    }
    console.log(`${"=".repeat(60)}\n`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
