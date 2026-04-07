import { describe, expect, it } from "vitest";
import { extractTeamId, extractTeamIdFromForm } from "./forward";
import linearFixture from "./fixtures/linear-webhook.json";
import githubFixture from "./fixtures/github-webhook.json";

describe("extractTeamId", () => {
  it("extracts organizationId from a Linear webhook payload", () => {
    const body = JSON.stringify(linearFixture);
    expect(extractTeamId("linear", body)).toBe("org-abc-123");
  });

  it("extracts installation.id from a GitHub webhook payload (stringified)", () => {
    const body = JSON.stringify(githubFixture);
    expect(extractTeamId("github", body)).toBe("12345678");
  });

  it("extracts team_id from a Slack event payload", () => {
    const body = JSON.stringify({ team_id: "T0ABCD123", event: { type: "message" } });
    expect(extractTeamId("slack", body)).toBe("T0ABCD123");
  });

  it("returns null for an invalid JSON body", () => {
    expect(extractTeamId("linear", "not json")).toBeNull();
  });

  it("returns null for a GitHub payload with no installation block", () => {
    const body = JSON.stringify({ action: "opened", repository: { id: 1 } });
    expect(extractTeamId("github", body)).toBeNull();
  });
});

describe("extractTeamIdFromForm", () => {
  it("extracts team_id from a Slack slash command form body", () => {
    const body = "token=abc&team_id=T0ABCD123&command=%2Fvera&text=hello";
    expect(extractTeamIdFromForm(body)).toBe("T0ABCD123");
  });

  it("returns null when team_id is missing", () => {
    expect(extractTeamIdFromForm("token=abc&command=%2Fvera")).toBeNull();
  });
});
