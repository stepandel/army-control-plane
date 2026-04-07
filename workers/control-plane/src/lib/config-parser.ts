/**
 * Parse `.vera/` configuration files (skills, workflows, crons) into
 * structured JSON for the dashboard API.
 *
 * Files live in the tenant's Tigris bucket and are read via `lib/tigris.ts`.
 * This module is responsible for the parsing/grouping/filtering only — it
 * does not talk to S3 directly.
 *
 * Skill files have YAML frontmatter delimited by `---` followed by markdown.
 * Workflow and cron files are pure YAML.
 */

import { load as parseYaml } from "js-yaml";
import {
  listVeraFiles,
  readVeraFile,
  type TigrisFile,
} from "./tigris";
import type { S3Client } from "@aws-sdk/client-s3";

// ── Public types ─────────────────────────────────────────────────

export interface SkillSummary {
  name: string;
  description: string;
  scopes: string[];
  file_path: string;
  has_scripts: boolean;
  has_references: boolean;
}

export interface WorkflowInputSummary {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
}

export interface WorkflowSummary {
  name: string;
  description: string;
  inputs: WorkflowInputSummary[];
  step_count: number;
  has_approval_gates: boolean;
  file_path: string;
}

export interface CronSummary {
  name: string;
  description: string;
  schedule: string;
  timezone?: string;
  enabled: boolean;
  type: string;
  workflow?: string;
  prompt?: string;
  file_path: string;
}

export interface ConfigBundle {
  skills: SkillSummary[];
  workflows: WorkflowSummary[];
  crons: CronSummary[];
  errors: string[];
}

// ── Frontmatter helpers ──────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  try {
    const parsed = parseYaml(match[1]);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

// ── Skill parsing ────────────────────────────────────────────────

/**
 * List and parse all skills under `.vera/skills/<name>/SKILL.md`.
 *
 * Each skill lives in its own directory; the optional `scripts/` and
 * `references/` subdirectories are surfaced as boolean flags so the
 * dashboard can show "has helper scripts".
 */
export async function listSkills(
  client: S3Client,
  bucket: string,
): Promise<{ skills: SkillSummary[]; errors: string[] }> {
  const errors: string[] = [];
  const files = await listVeraFiles(client, bucket, ".vera/skills/");

  // Build a quick lookup of every key under .vera/skills/ so we can detect
  // scripts/ and references/ subdirectories without extra API calls.
  const allKeys = new Set(files.map((f) => f.key));

  // SKILL.md files only
  const skillFiles = files.filter((f) => f.key.endsWith("/SKILL.md"));

  const skills: SkillSummary[] = [];
  for (const file of skillFiles) {
    const skillDir = file.key.replace(/SKILL\.md$/, ""); // ".vera/skills/foo/"
    try {
      const content = await readVeraFile(client, bucket, file.key);
      const fm = parseFrontmatter(content);
      if (!fm) {
        errors.push(`${file.key}: missing or invalid YAML frontmatter`);
        continue;
      }
      const name = asString(fm.name) || skillDir.split("/").slice(-2, -1)[0] || "unnamed";
      skills.push({
        name,
        description: asString(fm.description),
        scopes: asStringArray(fm.scopes),
        file_path: file.key,
        has_scripts: hasSubdir(allKeys, skillDir, "scripts/"),
        has_references: hasSubdir(allKeys, skillDir, "references/"),
      });
    } catch (err) {
      errors.push(`${file.key}: ${errorMessage(err)}`);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
}

function hasSubdir(allKeys: Set<string>, baseDir: string, subdir: string): boolean {
  const prefix = baseDir + subdir;
  for (const key of allKeys) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

// ── Workflow parsing ─────────────────────────────────────────────

/**
 * List and parse all workflows under `.vera/workflows/*.yaml`.
 *
 * The `runs/` subdirectory holds execution logs, not definitions, and is
 * excluded from the listing.
 */
export async function listWorkflows(
  client: S3Client,
  bucket: string,
): Promise<{ workflows: WorkflowSummary[]; errors: string[] }> {
  const errors: string[] = [];
  const files = await listVeraFiles(client, bucket, ".vera/workflows/");

  const workflowFiles = files.filter((f) => isYamlAtTopLevel(f, ".vera/workflows/"));

  const workflows: WorkflowSummary[] = [];
  for (const file of workflowFiles) {
    try {
      const content = await readVeraFile(client, bucket, file.key);
      const parsed = parseYaml(content);
      if (typeof parsed !== "object" || parsed === null) {
        errors.push(`${file.key}: not a YAML object`);
        continue;
      }
      const wf = parsed as Record<string, unknown>;
      const fallbackName = baseName(file.key);
      const inputs = parseWorkflowInputs(wf.inputs);
      const steps = Array.isArray(wf.steps) ? wf.steps : [];
      workflows.push({
        name: asString(wf.name) || fallbackName,
        description: asString(wf.description),
        inputs,
        step_count: steps.length,
        has_approval_gates: stepsHaveApproval(steps),
        file_path: file.key,
      });
    } catch (err) {
      errors.push(`${file.key}: ${errorMessage(err)}`);
    }
  }

  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows, errors };
}

function parseWorkflowInputs(value: unknown): WorkflowInputSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((input) => ({
      name: asString(input.name),
      description: typeof input.description === "string" ? input.description : undefined,
      default: input.default !== undefined ? String(input.default) : undefined,
      required: typeof input.required === "boolean" ? input.required : undefined,
    }))
    .filter((i) => i.name.length > 0);
}

function stepsHaveApproval(steps: unknown[]): boolean {
  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const s = step as Record<string, unknown>;
    if (s.approval !== undefined) return true;
    if (typeof s.tool === "string" && s.tool === "approval") return true;
  }
  return false;
}

// ── Cron parsing ─────────────────────────────────────────────────

/**
 * List and parse all crons under `.vera/crons/*.yaml`.
 *
 * Like workflows, `runs/` is excluded.
 */
export async function listCrons(
  client: S3Client,
  bucket: string,
): Promise<{ crons: CronSummary[]; errors: string[] }> {
  const errors: string[] = [];
  const files = await listVeraFiles(client, bucket, ".vera/crons/");

  const cronFiles = files.filter((f) => isYamlAtTopLevel(f, ".vera/crons/"));

  const crons: CronSummary[] = [];
  for (const file of cronFiles) {
    try {
      const content = await readVeraFile(client, bucket, file.key);
      const parsed = parseYaml(content);
      if (typeof parsed !== "object" || parsed === null) {
        errors.push(`${file.key}: not a YAML object`);
        continue;
      }
      const cron = parsed as Record<string, unknown>;
      const fallbackName = baseName(file.key);
      crons.push({
        name: asString(cron.name) || fallbackName,
        description: asString(cron.description),
        schedule: asString(cron.schedule),
        timezone: typeof cron.timezone === "string" ? cron.timezone : undefined,
        enabled: cron.enabled !== false, // default to enabled if unspecified
        type: asString(cron.type) || (cron.workflow ? "workflow" : "prompt"),
        workflow: typeof cron.workflow === "string" ? cron.workflow : undefined,
        prompt: typeof cron.prompt === "string" ? cron.prompt : undefined,
        file_path: file.key,
      });
    } catch (err) {
      errors.push(`${file.key}: ${errorMessage(err)}`);
    }
  }

  crons.sort((a, b) => a.name.localeCompare(b.name));
  return { crons, errors };
}

// ── Combined ─────────────────────────────────────────────────────

/**
 * Fetch all configuration in parallel and return a single bundle.
 * Errors from any individual section are collected (rather than thrown)
 * so a single bad file can't blank the whole dashboard.
 */
export async function listConfig(
  client: S3Client,
  bucket: string,
): Promise<ConfigBundle> {
  const [skillsResult, workflowsResult, cronsResult] = await Promise.all([
    listSkills(client, bucket),
    listWorkflows(client, bucket),
    listCrons(client, bucket),
  ]);
  return {
    skills: skillsResult.skills,
    workflows: workflowsResult.workflows,
    crons: cronsResult.crons,
    errors: [...skillsResult.errors, ...workflowsResult.errors, ...cronsResult.errors],
  };
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * True if the file lives directly under the given top-level prefix and is
 * a `.yaml`/`.yml` file. Excludes nested subdirectories like `runs/`.
 */
function isYamlAtTopLevel(file: TigrisFile, prefix: string): boolean {
  if (!file.key.startsWith(prefix)) return false;
  const rest = file.key.slice(prefix.length);
  if (rest.includes("/")) return false; // nested (e.g., runs/...)
  return rest.endsWith(".yaml") || rest.endsWith(".yml");
}

function baseName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.(ya?ml)$/i, "");
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
