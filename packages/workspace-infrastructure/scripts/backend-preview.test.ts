import { expect, test } from "bun:test";
import { checkPilotHead } from "./backend-preview";

const pilot = {
  pr: "8",
  sha: "a".repeat(40),
  ref: "feature/generation",
  neonBranch: "br-synthetic-test-branch",
};

const github =
  (state: "open" | "closed", { sha = pilot.sha, id = 1015951989 } = {}) =>
  async (url: string, init: RequestInit) => {
    expect(url).toBe(
      "https://api.github.com/repos/Deskohub/deskohub-site/pulls/8"
    );
    expect(init.redirect).toBe("error");
    return Response.json({
      state,
      draft: false,
      head: { ref: pilot.ref, sha, repo: { id } },
    });
  };

test("a closed-head cleanup cannot act on a reopened PR or a stale commit", async () => {
  await checkPilotHead(
    pilot,
    "closed",
    github("closed"),
    "synthetic-github-token"
  );
  await expect(
    checkPilotHead(pilot, "closed", github("open"), "synthetic-github-token")
  ).rejects.toThrow("moved or changed state");
  await expect(
    checkPilotHead(
      pilot,
      "closed",
      github("closed", { sha: "b".repeat(40) }),
      "synthetic-github-token"
    )
  ).rejects.toThrow("moved or changed state");
});

test("a deploy cannot act on a closed head or fork", async () => {
  await checkPilotHead(pilot, "open", github("open"), "synthetic-github-token");
  await expect(
    checkPilotHead(pilot, "open", github("closed"), "synthetic-github-token")
  ).rejects.toThrow("moved or changed state");
  await expect(
    checkPilotHead(
      pilot,
      "open",
      github("open", { id: 11 }),
      "synthetic-github-token"
    )
  ).rejects.toThrow("not internal");
});
