const LABEL_GROUP_NAME = "Anton Controls";

const LABELS = [
  { name: "!research", color: "#34D399", description: "Deep-dive research across the web and codebase, returns a written report" },
  { name: "!plan", color: "#34D399", description: "Break down the ticket into subtasks and propose an implementation plan" },
  { name: "!triage", color: "#34D399", description: "Investigate the bug or issue, identify root cause, and recommend a fix" },
  { name: "!execute", color: "#34D399", description: "(default behaviour) Implement the solution and open a pull request" },
  { name: "!review", color: "#34D399", description: "Review the pull request for correctness, style, and edge cases" },
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
 * Idempotent — skips creation if the group/labels already exist.
 */
export async function provisionLinearLabels(accessToken: string) {
  // Step 1 — Check for existing label group
  const { issueLabelGroups } = await linearGraphQL<{
    issueLabelGroups: { nodes: { id: string; name: string }[] };
  }>(accessToken, `{ issueLabelGroups { nodes { id name } } }`);

  let groupId: string;
  const existing = issueLabelGroups.nodes.find((g) => g.name === LABEL_GROUP_NAME);

  if (existing) {
    groupId = existing.id;
  } else {
    // Step 2 — Create the label group
    const { issueLabelGroupCreate } = await linearGraphQL<{
      issueLabelGroupCreate: { labelGroup: { id: string }; success: boolean };
    }>(
      accessToken,
      `mutation ($input: IssueLabelGroupCreateInput!) {
        issueLabelGroupCreate(input: $input) { labelGroup { id } success }
      }`,
      { input: { name: LABEL_GROUP_NAME } },
    );
    if (!issueLabelGroupCreate.success) throw new Error("Failed to create label group");
    groupId = issueLabelGroupCreate.labelGroup.id;
  }

  // Fetch existing labels in this group with color/description for diffing
  const { issueLabels } = await linearGraphQL<{
    issueLabels: { nodes: { id: string; name: string; color: string; description?: string }[] };
  }>(accessToken, `{ issueLabels(filter: { group: { id: { eq: "${groupId}" } } }) { nodes { id name color description } } }`);

  const existingByName = new Map(issueLabels.nodes.map((l) => [l.name, l]));
  const desiredNames: Set<string> = new Set(LABELS.map((l) => l.name));

  // Step 3 — Create missing labels, update existing ones if color/description changed
  let created = 0;
  let updated = 0;
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
        { input: { name: label.name, color: label.color, description: label.description, labelGroupId: groupId } },
      );
      if (!issueLabelCreate.success) throw new Error(`Failed to create label ${label.name}`);
      created++;
      continue;
    }

    // Update if color or description drifted
    if (existing.color !== label.color || (existing.description ?? "") !== label.description) {
      await linearGraphQL<{ issueLabelUpdate: { success: boolean } }>(
        accessToken,
        `mutation ($id: String!, $input: IssueLabelUpdateInput!) {
          issueLabelUpdate(id: $id, input: $input) { success }
        }`,
        { id: existing.id, input: { color: label.color, description: label.description } },
      );
      updated++;
    }
  }

  // Step 4 — Archive labels in the group that are no longer in LABELS
  let archived = 0;
  for (const [name, id] of existingByName) {
    if (desiredNames.has(name)) continue;

    const { issueLabelArchive } = await linearGraphQL<{
      issueLabelArchive: { success: boolean };
    }>(
      accessToken,
      `mutation ($id: String!) { issueLabelArchive(id: $id) { success } }`,
      { id },
    );
    if (!issueLabelArchive.success) throw new Error(`Failed to archive label ${name}`);
    archived++;
  }

  console.log(`Linear labels: ${created} created, ${updated} updated, ${archived} archived`);
}
