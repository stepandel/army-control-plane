const LABEL_GROUP_NAME = "Anton Controls";

const LABELS = [
  { name: "!research", color: "#A78BFA", description: "Comprehensive research using web tools and codebase" },
  { name: "!plan", color: "#60A5FA", description: "Researches the problem and codebase, breaks down the ticket into subtickets and proposes the implementation plan" },
  { name: "!triage", color: "#F87171", description: "Goes deep into the problem/bug and proposes a fix — puts up a PR" },
  { name: "!execute", color: "#34D399", description: "Implements the solution for the specified ticket" },
  { name: "!qa", color: "#FBBF24", description: "Reviews the PR" },
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

  // Fetch existing labels in this group to skip duplicates
  const { issueLabels } = await linearGraphQL<{
    issueLabels: { nodes: { id: string; name: string }[] };
  }>(accessToken, `{ issueLabels(filter: { group: { id: { eq: "${groupId}" } } }) { nodes { id name } } }`);

  const existingNames = new Set(issueLabels.nodes.map((l) => l.name));

  // Step 3 — Create each label (skip if already exists)
  let created = 0;
  for (const label of LABELS) {
    if (existingNames.has(label.name)) continue;

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
  }

  console.log(`Linear labels: ${created} created, ${LABELS.length - created} already existed`);
}
