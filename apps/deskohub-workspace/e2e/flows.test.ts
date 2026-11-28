import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyE2EStatusDescription,
  diffFlowIds,
  findCoveringCarriedSource,
  formatE2EStatusDescription,
  isWorkspaceE2ECaseSelected,
  needsWorkspaceE2ECheckoutPreparation,
  parsePrBodyE2EFlows,
  parseWorkspaceE2EFlowsInput,
  resolveWorkspaceE2EFlowSelection,
  selectedWorkspaceE2ECheckoutProjects,
  selectedWorkspaceE2EInstantNavigationPlan,
  summarizeCommitStatuses,
  unionFlowIds,
  workspaceE2ECaseFlowById,
  workspaceE2ECheckoutProjectFlowByName,
  workspaceE2EFlowIds,
  workspaceE2EFlowShortCodes,
  workspaceE2EInstantNavigationSpecFlowByFile,
  workspaceE2EWorkflowFlowIds,
} from "./flows";
import { workspaceE2ECaseIds } from "./playwright-checkout/case-catalog";

describe("Workspace E2E flow catalog", () => {
  test("matches the workflow flow catalog in order and short codes", () => {
    expect<readonly string[]>([...workspaceE2EFlowIds]).toEqual([
      ...workspaceE2EWorkflowFlowIds,
    ]);
    const shortCodes = Object.values(workspaceE2EFlowShortCodes);
    expect(new Set(shortCodes).size).toBe(workspaceE2EFlowIds.length);
  });

  test("maps every checkout case and every instant-navigation spec file to a flow", () => {
    expect(Object.keys(workspaceE2ECaseFlowById).sort()).toEqual(
      [...workspaceE2ECaseIds].sort()
    );

    const instantNavigationFiles = readdirSync(
      resolve(import.meta.dir, "instant-navigation")
    )
      .filter(
        (file) =>
          file.endsWith(".pw.ts") &&
          file !== "administrator-setup.pw.ts" &&
          file !== "administrator-cleanup.pw.ts"
      )
      .sort();
    expect(
      Object.keys(workspaceE2EInstantNavigationSpecFlowByFile).sort()
    ).toEqual(instantNavigationFiles);

    expect(Object.keys(workspaceE2ECheckoutProjectFlowByName).sort()).toEqual([
      "access-code-creation",
      "account-auth",
      "administrator-access",
      "email-campaign-recipient-preview",
    ]);
  });
});

describe("PR description ## E2E flows parser", () => {
  test("accepts valid flow subsets, all, none, comments, backticks, and notes", () => {
    expect(
      parsePrBodyE2EFlows(
        "## Summary\n\nChange\n\n## E2E flows\n<!-- comment -->\n- `email-campaigns`: pass reminders\n* admin\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin,email-campaigns",
      selected: ["admin", "email-campaigns"],
      runE2E: true,
      installWebkit: false,
    });

    expect(parsePrBodyE2EFlows("## E2E flows\n- `all`\n")).toMatchObject({
      ok: true,
      kind: "all",
      flows: "all",
      runE2E: true,
      installWebkit: true,
    });

    expect(parsePrBodyE2EFlows("## E2E Flows:\n- none\n")).toMatchObject({
      ok: true,
      kind: "none",
      flows: "none",
      selected: [],
      runE2E: false,
      installWebkit: false,
    });

    // Valid GFM closing hash sequences on ATX level-two headings.
    expect(parsePrBodyE2EFlows("## E2E flows ##\n- admin\n")).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
    });
    expect(
      parsePrBodyE2EFlows("## E2E flows: ###   \n- `account`\n")
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "account",
    });

    // Per GFM §4.3 / §4.1, trailing HTML comments prevent Setext underlines
    // and thematic breaks from closing a paragraph, so a following `<span>`
    // stays inline paragraph text and does not hide `## E2E flows`.
    expect(
      parsePrBodyE2EFlows(
        "Summary\n=== <!-- note -->\n<span>\n## E2E flows\n- admin\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
    });
    expect(
      parsePrBodyE2EFlows(
        "Summary\n--- <!-- note -->\n<span>\n## E2E flows\n- admin\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
    });

    // Per GFM §4.2 / §6.6, an unclosed inline `<!--` inside a heading or
    // paragraph is bounded to its block and cannot hide a subsequent
    // `## E2E flows` heading.
    expect(
      parsePrBodyE2EFlows(
        "## Summary <!-- unclosed\n## E2E flows\n- none\n## End\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "none",
      flows: "none",
    });
    expect(
      parsePrBodyE2EFlows(
        "Some paragraph <!-- unclosed\n## E2E flows\n- none\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "none",
      flows: "none",
    });

    // Per GFM §4.3 / §4.6, a Setext underline closes an open paragraph even
    // while an inline HTML comment is unfinished, so a following standalone
    // type-7 HTML tag opens an HTML block and hides heading-like text inside it.
    expect(
      parsePrBodyE2EFlows(
        "Summary <!-- open\n===\n<x-box>\n## E2E flows\n- fake\n</x-box>\n\n## E2E flows\n- admin\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
    });
    expect(
      parsePrBodyE2EFlows(
        "Summary <!-- open\nline 2\n===\n<x-box>\n## E2E flows\n- fake\n</x-box>\n\n## E2E flows\n- admin\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
    });

    // Per GFM §5.2 & §2.2, an empty list-item marker (`+`, `-`, `*`) indented
    // to or beyond the item's 4-column tab-stop content indent cannot interrupt
    // its paragraph, so it stays hidden inside a multiline inline HTML comment.
    expect(
      parsePrBodyE2EFlows("## E2E flows\n- admin <!-- start\n  +\n  end -->\n")
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
      selected: ["admin"],
    });
    expect(
      parsePrBodyE2EFlows("## E2E flows\n-\tadmin <!-- start\n\t+\n\tend -->\n")
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
      selected: ["admin"],
    });
    expect(
      parsePrBodyE2EFlows(
        "## E2E flows\n-\tadmin <!-- start\n    +\n    end -->\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
      selected: ["admin"],
    });
    expect(
      parsePrBodyE2EFlows(
        "## E2E flows\n- \tadmin <!-- start\n    *\n    end -->\n"
      )
    ).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "admin",
      selected: ["admin"],
    });

    // Listing every individual flow normalizes to `all`.
    const everyFlowBody = `## E2E flows\n${workspaceE2EFlowIds.map((id) => `- ${id}`).join("\n")}\n`;
    expect(parsePrBodyE2EFlows(everyFlowBody)).toMatchObject({
      ok: true,
      kind: "all",
      flows: "all",
      installWebkit: true,
    });
  });

  test("ignores fake headings inside fenced, indented code blocks, and HTML comments", () => {
    const body = [
      "## Summary",
      "<!--",
      "## E2E flows",
      "- none",
      "-->",
      "```markdown",
      "## E2E flows",
      "- fake",
      "```",
      "~~~md",
      "## E2E flows",
      "- fake-tilde",
      "~~~",
      "",
      "    ## E2E flows",
      "    - none",
      "",
      "## E2E flows",
      "- `webkit`",
      "## Notes",
      "More text",
    ].join("\n");

    expect(parsePrBodyE2EFlows(body)).toMatchObject({
      ok: true,
      kind: "subset",
      flows: "webkit",
      installWebkit: true,
    });
  });

  test.each([
    [
      "heading inside raw <pre> HTML block",
      "<pre>\n## E2E flows\n- none\n## End\n</pre>\n",
    ],
    [
      "heading inside raw <details> HTML block without blank line",
      "<details><summary>Details</summary>\n## E2E flows\n- none\n## End\n</details>\n",
    ],
    [
      "heading inside raw <div> HTML block",
      "<div>\n## E2E flows\n- none\n## End\n</div>\n",
    ],
    [
      "heading inside standalone type-7 HTML block immediately after an ATX heading",
      "# Summary\n<x-box>\n## E2E flows\n- admin\n## End\n</x-box>\n",
    ],
    [
      "heading inside standalone type-7 HTML block immediately after a Setext === heading",
      "Summary\n===\n<x-box>\n## E2E flows\n- admin\n## End\n</x-box>\n",
    ],
    [
      "heading inside standalone type-7 HTML block immediately after a Setext --- heading",
      "Summary\n---\n<x-box>\n## E2E flows\n- admin\n## End\n</x-box>\n",
    ],
    [
      "heading inside tag with > in double-quoted attribute",
      '<span data-x="a>b">\n## E2E flows\n- admin\n## End\n</span>\n',
    ],
    [
      "heading inside tag with > in single-quoted attribute",
      "<span data-x='a>b'>\n## E2E flows\n- admin\n## End\n</span>\n",
    ],
    [
      "heading inside unclosed HTML comment",
      "## Summary\n<!-- unclosed template comment\n## E2E flows\n- none\n## End\n",
    ],
    [
      "section heading with unclosed inline HTML comment as literal text",
      "## E2E flows <!-- unclosed\n- none\n",
    ],
  ])("reports missing section for %s", (_label, body) => {
    const parsed = parsePrBodyE2EFlows(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("Missing `## E2E flows`");
    }
  });

  test.each([
    ["missing section", "## Summary\nNo flows here"],
    ["level-three heading", "### E2E flows\n- none"],
    ["closing hashes without preceding space", "## E2E flows##\n- none\n"],
    [
      "indented code block only",
      "## Summary\n\n    ## E2E flows\n    - none\n",
    ],
    ["indented bullet inside section", "## E2E flows\n    - none\n"],
    ["code block inside section", "## E2E flows\n```\n- admin\n```\n"],
    ["raw HTML block inside section", "## E2E flows\n<pre>\n- none\n</pre>\n"],
    ["empty section", "## E2E flows\n\n<!-- only comment -->\n## Next\nText"],
    ["duplicate sections", "## E2E flows\n- admin\n## E2E flows\n- account"],
    ["unknown flow", "## E2E flows\n- checkout-magic"],
    ["mixing all with another flow", "## E2E flows\n- all\n- admin"],
    ["mixing none with another flow", "## E2E flows\n- none\n- admin"],
    ["mixing all and none", "## E2E flows\n- all\n- none"],
    ["non-bullet prose", "## E2E flows\nadmin"],
    ["space typo inside flow name", "## E2E flows\n- checkout cowork"],
    [
      "sibling * list item closing an unfinished inline comment",
      "## E2E flows\n* admin <!-- start\n*\n  follow-up -->\n",
    ],
    [
      "sibling - list item closing an unfinished inline comment",
      "## E2E flows\n- admin <!-- start\n-\n  follow-up -->\n",
    ],
    [
      "mixed space-tab bullet followed by sibling * at column 2 (< 4)",
      "## E2E flows\n- \tnone <!-- start\n  *\n    bogus -->\n",
    ],
    [
      "tab-separated bullet followed by sibling * at column 3 (< 4)",
      "## E2E flows\n-\tadmin <!-- start\n   *\n    bogus -->\n",
    ],
  ])("fails closed on %s", (_label, body) => {
    expect(parsePrBodyE2EFlows(body).ok).toBe(false);
  });
});

describe("flow selection planning", () => {
  test("selects only required projects, specs, and checkout preparation", () => {
    const adminOnly = resolveWorkspaceE2EFlowSelection("admin");
    expect(needsWorkspaceE2ECheckoutPreparation(adminOnly)).toBe(false);
    expect(selectedWorkspaceE2ECheckoutProjects(adminOnly)).toEqual([
      "administrator-access",
    ]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(adminOnly)).toEqual({
      projects: ["administration-navigation"],
      navigationSpecs: [],
    });

    const emailOnly = resolveWorkspaceE2EFlowSelection("email-campaigns");
    expect(needsWorkspaceE2ECheckoutPreparation(emailOnly)).toBe(false);
    expect(
      needsWorkspaceE2ECheckoutPreparation(emailOnly, {
        includeNightlyCases: true,
      })
    ).toBe(true);
    expect(selectedWorkspaceE2ECheckoutProjects(emailOnly)).toEqual([
      "email-campaign-recipient-preview",
    ]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(emailOnly)).toEqual({
      projects: [],
      navigationSpecs: [],
    });

    const publicOnly = resolveWorkspaceE2EFlowSelection("public-site");
    expect(needsWorkspaceE2ECheckoutPreparation(publicOnly)).toBe(false);
    expect(selectedWorkspaceE2ECheckoutProjects(publicOnly)).toEqual([
      "checkout-cases",
    ]);
    expect(isWorkspaceE2ECaseSelected("contact-form", publicOnly)).toBe(true);
    expect(
      isWorkspaceE2ECaseSelected("checkout-cowork-basic", publicOnly)
    ).toBe(false);
    expect(selectedWorkspaceE2EInstantNavigationPlan(publicOnly)).toEqual({
      projects: ["navigation"],
      navigationSpecs: [
        "customer-route-fallbacks.pw.ts",
        "public-account-legal.pw.ts",
        "public-navigation.pw.ts",
        "reservation-navigation.pw.ts",
      ],
    });

    const webkitOnly = resolveWorkspaceE2EFlowSelection("webkit");
    expect(selectedWorkspaceE2ECheckoutProjects(webkitOnly)).toEqual([]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(webkitOnly)).toEqual({
      projects: ["navigation", "webkit"],
      navigationSpecs: ["temporal-runtime.pw.ts"],
    });

    const tableOnly = resolveWorkspaceE2EFlowSelection("checkout-table");
    expect(needsWorkspaceE2ECheckoutPreparation(tableOnly)).toBe(true);
    expect(selectedWorkspaceE2ECheckoutProjects(tableOnly)).toEqual([
      "checkout-cases",
    ]);
    expect(isWorkspaceE2ECaseSelected("checkout-table-paid", tableOnly)).toBe(
      true
    );
    expect(
      isWorkspaceE2ECaseSelected("reservation-url-state-table", tableOnly)
    ).toBe(true);
    expect(
      isWorkspaceE2ECaseSelected("checkout-office-paid-multi-day", tableOnly)
    ).toBe(false);

    const none = resolveWorkspaceE2EFlowSelection("none");
    expect(selectedWorkspaceE2ECheckoutProjects(none)).toEqual([]);
    expect(selectedWorkspaceE2EInstantNavigationPlan(none)).toEqual({
      projects: [],
      navigationSpecs: [],
    });
  });

  test("rejects malformed comma-separated inputs", () => {
    expect(parseWorkspaceE2EFlowsInput("").ok).toBe(false);
    expect(parseWorkspaceE2EFlowsInput("admin,").ok).toBe(false);
    expect(parseWorkspaceE2EFlowsInput("all,admin").ok).toBe(false);
    expect(parseWorkspaceE2EFlowsInput("bogus").ok).toBe(false);
  });
});

describe("commit status description encoding and coverage summary", () => {
  test("stays within GitHub's 140-char limit and round-trips every subset size", () => {
    const sha = "a".repeat(40);
    const largeSubset = workspaceE2EFlowIds.slice(0, 12).join(",");

    for (const flows of [
      "all",
      "admin",
      "admin,email-campaigns",
      largeSubset,
    ]) {
      for (const kind of [
        "passed",
        "restored",
        "partial",
        "running",
        "failed",
        "same-tree-passed",
      ] as const) {
        const description = formatE2EStatusDescription({
          kind,
          flows,
          sourceSha: sha,
        });
        expect(description.length).toBeLessThanOrEqual(140);
        const classified = classifyE2EStatusDescription(description);
        expect(classified.kind).toBe(
          kind === "same-tree-passed" ? "carried-passed" : kind
        );
        if (classified.kind !== "other" && classified.kind !== "superseded") {
          const expected =
            flows === "all" ? [...workspaceE2EFlowIds] : flows.split(",");
          expect<readonly string[]>([...classified.selected]).toEqual(expected);
        }
      }
    }

    const skipped = formatE2EStatusDescription({ kind: "skipped-none" });
    expect(skipped.length).toBeLessThanOrEqual(140);
    expect(classifyE2EStatusDescription(skipped)).toEqual({
      kind: "skipped-none",
      selected: [],
    });
  });

  test("unions passed flows across runs, tracks in-flight flows, and lets a newer failure override an older pass", () => {
    const summary = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description:
          "Protected preview E2E is running [flows: email-campaigns]",
        state: "pending",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E passed [flows: admin]",
        state: "success",
      },
    ]);

    expect(summary.latestRunKind).toBe("running");
    expect(summary.passedFlows).toEqual(["admin"]);
    expect(summary.runningFlows).toEqual(["email-campaigns"]);
    expect(
      diffFlowIds(["admin", "email-campaigns"], summary.passedFlows)
    ).toEqual(["email-campaigns"]);
    expect(unionFlowIds(summary.passedFlows, summary.runningFlows)).toEqual([
      "admin",
      "email-campaigns",
    ]);

    const afterFailure = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E failed [flows: admin]",
        state: "failure",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description:
          "Protected preview E2E passed [flows: admin,email-campaigns]",
        state: "success",
      },
    ]);
    expect(afterFailure.latestRunState).toBe("failure");
    expect(afterFailure.passedFlows).toEqual(["email-campaigns"]);
    expect(afterFailure.realPassedFlows).toEqual(["email-campaigns"]);
    expect(afterFailure.failedFlows).toEqual(["admin"]);

    // An active rerun excludes older passes for the flow being rerun, while a
    // superseded pending run does not erase an earlier pass.
    const activeRerun = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E is running [flows: admin]",
        state: "pending",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description:
          "Protected preview E2E passed [flows: admin,email-campaigns]",
        state: "success",
      },
    ]);
    expect(activeRerun.latestRunKind).toBe("running");
    expect(activeRerun.runningFlows).toEqual(["admin"]);
    expect(activeRerun.realPassedFlows).toEqual(["email-campaigns"]);
    expect(activeRerun.passedFlows).toEqual(["email-campaigns"]);

    const supersededRerun = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Superseded by a newer PR head before E2E finished",
        state: "failure",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E is running [flows: admin]",
        state: "pending",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E passed [flows: admin]",
        state: "success",
      },
    ]);
    expect(supersededRerun.latestRunKind).toBe("superseded");
    expect(supersededRerun.realPassedFlows).toEqual(["admin"]);

    // Switching selection to another already-passed flow (`webkit`) posts a
    // newer pass above the still-running `admin` run; `admin` must remain
    // active rather than falling back to the older `admin,webkit` pass.
    const activeAcrossSelectionChange = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E passed [flows: webkit]",
        state: "success",
        target_url: "https://github.com/owner/repo/actions/runs/300",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E is running [flows: admin]",
        state: "pending",
        target_url: "https://github.com/owner/repo/actions/runs/200",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E passed [flows: admin,webkit]",
        state: "success",
        target_url: "https://github.com/owner/repo/actions/runs/100",
      },
    ]);
    expect(activeAcrossSelectionChange.realPassedFlows).toEqual(["webkit"]);
    expect(activeAcrossSelectionChange.runningFlows).toEqual(["admin"]);
    expect(activeAcrossSelectionChange.activeRuns).toEqual([
      {
        description: "Protected preview E2E is running [flows: admin]",
        flows: ["admin"],
        targetUrl: "https://github.com/owner/repo/actions/runs/200",
      },
    ]);

    // A restored status is never treated as proof of a real run result, so an
    // underlying real failure still governs.
    const restoredOverFailure = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E restored [flows: admin]",
        state: "success",
        target_url: "https://github.com/owner/repo/actions/runs/301",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E failed [flows: admin]",
        state: "failure",
        target_url: "https://github.com/owner/repo/actions/runs/205",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E passed [flows: admin]",
        state: "success",
        target_url: "https://github.com/owner/repo/actions/runs/100",
      },
    ]);
    expect(restoredOverFailure.realPassedFlows).toEqual([]);
    expect(restoredOverFailure.failedFlows).toEqual(["admin"]);

    // A run whose final publisher emitted a metadata failure is terminated and
    // must not remain in activeRuns.
    const terminatedByMetadataError = summarizeCommitStatuses([
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description:
          "Invalid or missing ## E2E flows in PR description; list valid flows, all, or none",
        state: "failure",
        target_url: "https://github.com/owner/repo/actions/runs/200",
      },
      {
        context: "Workspace E2E",
        creator: { login: "github-actions[bot]" },
        description: "Protected preview E2E is running [flows: admin]",
        state: "pending",
        target_url: "https://github.com/owner/repo/actions/runs/200",
      },
    ]);
    expect(terminatedByMetadataError.runningFlows).toEqual([]);
    expect(terminatedByMetadataError.activeRuns).toEqual([]);

    // A carried status sitting above a genuine head failure must never hide
    // that failure or advertise the failed flow as carried.
    const carriedAboveRealFailure = summarizeCommitStatuses(
      [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Same tree as bbbbbbb, which passed E2E [flows: admin,webkit]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E failed [flows: admin]",
          state: "failure",
        },
      ],
      { includeCarried: true }
    );
    expect(carriedAboveRealFailure.failedFlows).toEqual(["admin"]);
    expect(carriedAboveRealFailure.carriedPassedFlows).toEqual(["webkit"]);
    expect(carriedAboveRealFailure.passedFlows).toEqual(["webkit"]);

    const partialAndCarried = summarizeCommitStatuses(
      [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Protected preview E2E partial; more flows required [flows: admin]",
          state: "failure",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description:
            "Same tree as bbbbbbb, which passed E2E [flows: email-campaigns]",
          state: "success",
        },
      ],
      { includeCarried: true }
    );
    expect(partialAndCarried.realPassedFlows).toEqual(["admin"]);
    expect(partialAndCarried.carriedPassedFlows).toEqual(["email-campaigns"]);
    expect(partialAndCarried.carriedSourceSha).toBe("bbbbbbb");
    expect(partialAndCarried.passedFlows).toEqual(["admin", "email-campaigns"]);

    // Retain per-source provenance through head-failure filtering so surviving
    // carried coverage cites only the commit that actually passed those flows.
    const filteredProvenance = summarizeCommitStatuses(
      [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Protected preview E2E failed [flows: admin]",
          state: "failure",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as aaaaaaa, which passed E2E [flows: admin]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as bbbbbbb, which passed E2E [flows: webkit]",
          state: "success",
        },
      ],
      { includeCarried: true }
    );
    expect(filteredProvenance.failedFlows).toEqual(["admin"]);
    expect(filteredProvenance.carriedPassedFlows).toEqual(["webkit"]);
    expect(filteredProvenance.carriedSourceSha).toBe("bbbbbbb");
    expect(filteredProvenance.carriedSources).toEqual([
      { flows: ["webkit"], flowsCsv: "webkit", sourceSha: "bbbbbbb" },
    ]);
    expect(
      findCoveringCarriedSource(filteredProvenance.carriedSources, ["webkit"])
    ).toEqual({ flows: ["webkit"], flowsCsv: "webkit", sourceSha: "bbbbbbb" });

    // Distinct carried sources must not be merged under one commit SHA.
    const splitSources = summarizeCommitStatuses(
      [
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as aaaaaaa, which passed E2E [flows: admin]",
          state: "success",
        },
        {
          context: "Workspace E2E",
          creator: { login: "github-actions[bot]" },
          description: "Same tree as bbbbbbb, which passed E2E [flows: webkit]",
          state: "success",
        },
      ],
      { includeCarried: true }
    );
    expect(
      findCoveringCarriedSource(splitSources.carriedSources, ["admin"])
    ).toEqual({ flows: ["admin"], flowsCsv: "admin", sourceSha: "aaaaaaa" });
    expect(
      findCoveringCarriedSource(splitSources.carriedSources, ["webkit"])
    ).toEqual({ flows: ["webkit"], flowsCsv: "webkit", sourceSha: "bbbbbbb" });
    expect(
      findCoveringCarriedSource(splitSources.carriedSources, [
        "admin",
        "webkit",
      ])
    ).toBeNull();
  });
});
