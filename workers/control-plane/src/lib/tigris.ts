/**
 * Tigris S3 client wrapper for the control plane.
 *
 * Each tenant's Fly machine has its own Tigris bucket (named by `fly_app_name`)
 * and the agent's `startTigrisSync()` continuously pushes `.vera/` config files
 * (skills, workflows, crons) to that bucket. The control plane reads from those
 * buckets to surface configuration on the user's dashboard — no API calls to
 * the tenant machine are required, so the dashboard works even when the machine
 * is stopped.
 *
 * Mirrors the S3 client setup from `scripts/migrate-tigris.ts`.
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { ControlPlaneEnv } from "@army/shared";

export interface TigrisFile {
  key: string;
  size: number;
  lastModified?: Date;
}

/**
 * Create an S3 client pointed at Tigris using credentials from the worker env.
 * Uses path-style URLs and the "auto" region the same way the migration script
 * does — Tigris is S3-compatible but requires `forcePathStyle: true`.
 */
export function createTigrisClient(env: ControlPlaneEnv): S3Client {
  return new S3Client({
    endpoint: env.TIGRIS_ENDPOINT,
    region: "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.TIGRIS_ACCESS_KEY_ID,
      secretAccessKey: env.TIGRIS_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * List all objects in a bucket under a given prefix, paginating through
 * continuation tokens. Returns an empty array if the bucket is empty or
 * doesn't exist (callers handle the empty case).
 */
export async function listVeraFiles(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<TigrisFile[]> {
  const files: TigrisFile[] = [];
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
      if (!obj.Key) continue;
      files.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified,
      });
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return files;
}

/**
 * Read a single object from a bucket and return its body as a UTF-8 string.
 * Throws if the object doesn't exist — callers should catch and skip.
 */
export async function readVeraFile(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new Error(`Empty body for ${key}`);
  return new TextDecoder().decode(bytes);
}
