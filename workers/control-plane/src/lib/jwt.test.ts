import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt } from "./jwt";

describe("session jwt", () => {
  it("round-trips a standalone account session without tenant fields", async () => {
    const token = await signJwt(
      {
        sub: "account-123",
        email: "user@example.com",
        name: "Standalone User",
      },
      "test-secret",
    );

    const payload = await verifyJwt(token, "test-secret");

    expect(payload).toMatchObject({
      sub: "account-123",
      email: "user@example.com",
      name: "Standalone User",
    });
    expect(payload?.team_id).toBeUndefined();
    expect(payload?.slack_uid).toBeUndefined();
  });

  it("round-trips a legacy Slack-backed session with tenant fields", async () => {
    const token = await signJwt(
      {
        sub: "user-123",
        team_id: "T123",
        slack_uid: "U123",
      },
      "test-secret",
    );

    const payload = await verifyJwt(token, "test-secret");

    expect(payload).toMatchObject({
      sub: "user-123",
      team_id: "T123",
      slack_uid: "U123",
    });
  });
});
