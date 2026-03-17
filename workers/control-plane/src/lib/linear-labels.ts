const LABEL_GROUP_NAME = "Anton Controls";

const LABELS = [
  { name: "#research", color: "#34D399", description: "Deep-dive research across the web and codebase, returns a written report" },
  { name: "#plan", color: "#34D399", description: "Break down the ticket into subtasks and propose an implementation plan" },
  { name: "#triage", color: "#34D399", description: "Investigate the bug or issue, identify root cause, and recommend a fix" },
  { name: "#execute", color: "#34D399", description: "(default behaviour) Implement the solution and open a pull request" },
  { name: "#review", color: "#34D399", description: "Review the pull request for correctness, style, and edge cases" },
] as const;

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function linearGraphQL<T>(accessToken: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await resp.json()) as GraphQLResponse<T>;
  if (json.errors?.length) throw new Error(`Linear GraphQL: ${json.errors[0].message}`);
  if (!json.data) throw new Error("Linear GraphQL: empty response");
  return json.data;
}

/**
 * Provision the "Anton Controls" label group and labels in the Linear workspace.
 * Idempotent — creates missing labels, updates drifted ones, archives removed ones.
 *
 * Linear models label groups as labels with `isGroup: true`.
 * Child labels reference the group via `parentId`.
 */
export async function provisionLinearLabels(accessToken: string) {
  // Step 1 — Find or create the group label
  const { issueLabels: groupLabels } = await linearGraphQL<{
    issueLabels: { nodes: { id: string; name: string }[] };
  }>(accessToken, `{
    issueLabels(filter: { isGroup: { eq: true }, name: { eq: "${LABEL_GROUP_NAME}" } }) {
      nodes { id name }
    }
  }`);

  let groupId: string;
  const existingGroup = groupLabels.nodes[0];

  if (existingGroup) {
    groupId = existingGroup.id;
  } else {
    const { issueLabelCreate } = await linearGraphQL<{
      issueLabelCreate: { issueLabel: { id: string }; success: boolean };
    }>(
      accessToken,
      `mutation ($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { issueLabel { id } success }
      }`,
      { input: { name: LABEL_GROUP_NAME, isGroup: true } },
    );
    if (!issueLabelCreate.success) throw new Error("Failed to create label group");
    groupId = issueLabelCreate.issueLabel.id;
  }

  // Step 2 — Fetch ALL labels with our names (workspace-wide, not just under our group)
  // This catches orphaned labels from previous failed provisioning attempts
  const { issueLabels } = await linearGraphQL<{
    issueLabels: { nodes: { id: string; name: string; color: string; description?: string; parent?: { id: string } }[] };
  }>(accessToken, `{
    issueLabels(filter: { name: { in: [${LABELS.map((l) => `"${l.name}"`).join(", ")}] } }) {
      nodes { id name color description parent { id } }
    }
  }`);

  const existingByName = new Map(issueLabels.nodes.map((l) => [l.name, l]));
  const desiredNames: Set<string> = new Set(LABELS.map((l) => l.name));

  // Also fetch labels under our group to detect stale ones that need archiving
  const { issueLabels: groupChildren } = await linearGraphQL<{
    issueLabels: { nodes: { id: string; name: string }[] };
  }>(accessToken, `{
    issueLabels(filter: { parent: { id: { eq: "${groupId}" } } }) {
      nodes { id name }
    }
  }`);

  // Step 3 — Create missing labels, adopt orphans, update drifted ones
  let created = 0;
  let updated = 0;
  let adopted = 0;
  for (const label of LABELS) {
    const existing = existingByName.get(label.name);

    if (!existing) {
      const { issueLabelCreate } = await linearGraphQL<{
        issueLabelCreate: { issueLabel: { id: string }; success: boolean };
      }>(
        accessToken,
        `mutation ($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { issueLabel { id } success }
        }`,
        { input: { name: label.name, color: label.color, description: label.description, parentId: groupId } },
      );
      if (!issueLabelCreate.success) throw new Error(`Failed to create label ${label.name}`);
      created++;
      continue;
    }

    // Build update payload for any drift (parent, color, description)
    const updates: Record<string, string> = {};
    if (existing.parent?.id !== groupId) updates.parentId = groupId;
    if (existing.color !== label.color) updates.color = label.color;
    if ((existing.description ?? "") !== label.description) updates.description = label.description;

    if (Object.keys(updates).length > 0) {
      await linearGraphQL<{ issueLabelUpdate: { success: boolean } }>(
        accessToken,
        `mutation ($id: String!, $input: IssueLabelUpdateInput!) {
          issueLabelUpdate(id: $id, input: $input) { success }
        }`,
        { id: existing.id, input: updates },
      );
      if (updates.parentId) adopted++;
      else updated++;
    }
  }

  // Step 4 — Archive labels in the group that are no longer in LABELS
  let archived = 0;
  for (const { name, id } of groupChildren.nodes) {
    if (desiredNames.has(name)) continue;

    const { issueLabelRetire } = await linearGraphQL<{
      issueLabelRetire: { success: boolean };
    }>(
      accessToken,
      `mutation ($id: String!) { issueLabelRetire(id: $id) { success } }`,
      { id },
    );
    if (!issueLabelRetire.success) throw new Error(`Failed to retire label ${name}`);
    archived++;
  }

  console.log(`Linear labels: ${created} created, ${updated} updated, ${adopted} adopted, ${archived} archived`);
}
