/**
 * Single source of truth for Workspace E2E flow identifiers, PR description
 * parsing, flow set operations, and GitHub commit status encoding.
 *
 * Kept dependency-free ESM so GitHub Actions workflows can run it directly
 * from `github.workflow_sha` without checking out PR code or installing
 * packages, while the Workspace E2E runner imports the exact same rules.
 */

export const WORKSPACE_E2E_FLOW_IDS = Object.freeze([
  "checkout-cowork",
  "checkout-meeting-room",
  "checkout-office",
  "checkout-table",
  "payments",
  "discounts",
  "referrals",
  "agent-booking",
  "account",
  "admin",
  "email-campaigns",
  "access-codes",
  "public-site",
  "webkit",
]);

export const WORKSPACE_E2E_FLOW_SHORT_CODES = Object.freeze({
  "checkout-cowork": "cc",
  "checkout-meeting-room": "cm",
  "checkout-office": "co",
  "checkout-table": "ct",
  payments: "py",
  discounts: "ds",
  referrals: "rf",
  "agent-booking": "ab",
  account: "ac",
  admin: "ad",
  "email-campaigns": "ec",
  "access-codes": "ax",
  "public-site": "ps",
  webkit: "wk",
});

export const WORKSPACE_E2E_STATUS_MAX_LENGTH = 140;
export const WORKSPACE_E2E_SUPERSEDED_DESCRIPTION =
  "Superseded by a newer PR head before E2E finished";

const flowIdSet = new Set(WORKSPACE_E2E_FLOW_IDS);
const flowIdByShortCode = new Map(
  Object.entries(WORKSPACE_E2E_FLOW_SHORT_CODES).map(([id, code]) => [code, id])
);
const flowOrderIndex = new Map(
  WORKSPACE_E2E_FLOW_IDS.map((id, index) => [id, index])
);

const sortUniqueFlowIds = (ids) =>
  [...new Set(ids)].sort(
    (left, right) =>
      (flowOrderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (flowOrderIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
  );

const buildFlowSelection = (selected) => {
  const ordered = sortUniqueFlowIds(selected);
  if (ordered.length === 0) {
    return {
      ok: true,
      kind: "none",
      flows: "none",
      selected: [],
      runE2E: false,
      installWebkit: false,
    };
  }
  if (ordered.length === WORKSPACE_E2E_FLOW_IDS.length) {
    return {
      ok: true,
      kind: "all",
      flows: "all",
      selected: [...WORKSPACE_E2E_FLOW_IDS],
      runE2E: true,
      installWebkit: true,
    };
  }
  return {
    ok: true,
    kind: "subset",
    flows: ordered.join(","),
    selected: ordered,
    runE2E: true,
    installWebkit: ordered.includes("webkit"),
  };
};

export const validFlowListMessage = () =>
  `Valid values: all, none, or a list from: ${WORKSPACE_E2E_FLOW_IDS.join(", ")}`;

export const parseFlowTokens = (tokens) => {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      ok: false,
      error: `The ## E2E flows section must list at least one flow, all, or none. ${validFlowListMessage()}`,
    };
  }
  const unknown = [];
  let hasAll = false;
  let hasNone = false;
  const flows = [];

  for (const rawToken of tokens) {
    const token = String(rawToken).trim();
    if (token === "all") {
      hasAll = true;
    } else if (token === "none") {
      hasNone = true;
    } else if (flowIdSet.has(token)) {
      flows.push(token);
    } else {
      unknown.push(token);
    }
  }

  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown E2E flow(s): ${unknown.join(", ")}. ${validFlowListMessage()}`,
    };
  }
  if (hasAll && (hasNone || flows.length > 0)) {
    return {
      ok: false,
      error:
        "Cannot combine `all` with `none` or specific flows in ## E2E flows.",
    };
  }
  if (hasNone && flows.length > 0) {
    return {
      ok: false,
      error: "Cannot combine `none` with specific flows in ## E2E flows.",
    };
  }
  if (hasAll) {
    return buildFlowSelection(WORKSPACE_E2E_FLOW_IDS);
  }
  if (hasNone) {
    return buildFlowSelection([]);
  }
  return buildFlowSelection(flows);
};

export const parseFlowsInput = (raw) => {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: `E2E flows input is empty. ${validFlowListMessage()}`,
    };
  }
  const parts = trimmed.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return {
      ok: false,
      error: `E2E flows input contains an empty entry. ${validFlowListMessage()}`,
    };
  }
  return parseFlowTokens(parts);
};

// Per GFM Section 4.2, ATX headings allow at most 3 leading spaces and an
// optional closing sequence of `#` preceded by spaces/tabs and followed only
// by spaces/tabs. 4+ leading spaces or a leading tab is an indented code block.
const stripClosingAtxHashes = (line) => line.replace(/[ \t]+#+[ \t]*$/, "");
const sectionHeadingPattern = /^ {0,3}##[ \t]+e2e[ \t]+flows[ \t]*:?[ \t]*$/i;
const anyHeadingPattern = /^ {0,3}#{1,6}(?:[ \t]+.*|[ \t]*)$/;
const setextUnderlinePattern = /^ {0,3}(?:=+|-+)[ \t]*$/;
const thematicBreakPattern =
  /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const fenceOpenPattern = /^ {0,3}(`{3,}|~{3,})/;
const indentedCodeLinePattern = /^(?: {4,}|\t)/;
const bulletPattern = /^ {0,3}[-*][ \t]+`?([^\s`:]+)`?(?:[ \t]*:[ \t]*\S.*)?$/;

// GFM Section 4.6 HTML block start/end patterns (types 1–7).
const htmlType1Start = /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|$)/i;
const htmlType1End = /<\/(?:pre|script|style|textarea)>/i;
const htmlType2Start = /^ {0,3}<!--/;
const htmlType3Start = /^ {0,3}<\?/;
const htmlType4Start = /^ {0,3}<![A-Za-z]/;
const htmlType5Start = /^ {0,3}<!\[CDATA\[/;
const htmlType6Start =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$)/i;
// Per GFM §6.6 + §4.6 type 7: complete open tag (supporting single/double-quoted
// attribute values that may contain `>`) or closing tag, followed only by
// optional spaces/tabs. Cannot interrupt a paragraph.
const htmlType7Start =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;

const matchHtmlBlockStart = (line, inParagraph) => {
  if (htmlType1Start.test(line)) {
    return { kind: "html-raw", endPattern: htmlType1End };
  }
  if (htmlType2Start.test(line)) {
    return { kind: "html-comment", endPattern: /-->/ };
  }
  if (htmlType3Start.test(line)) {
    return { kind: "html-raw", endPattern: /\?>/ };
  }
  if (htmlType4Start.test(line)) {
    return { kind: "html-raw", endPattern: />/ };
  }
  if (htmlType5Start.test(line)) {
    return { kind: "html-raw", endPattern: /\]\]>/ };
  }
  if (htmlType6Start.test(line)) {
    return { kind: "html-raw", endOnBlank: true };
  }
  if (!inParagraph && htmlType7Start.test(line)) {
    return { kind: "html-raw", endOnBlank: true };
  }
  return null;
};

/**
 * Strips inline HTML comments (`<!-- ... -->`) outside backtick code spans,
 * and reports whether an unclosed `<!--` remains open at end of line.
 * When `allowUnclosed` is false (single-line blocks such as ATX headings),
 * an unclosed `<!--` is preserved as literal text per GFM §4.2 / §6.6.
 */
const stripInlineHtmlComments = (
  line,
  inCommentStart,
  { allowUnclosed = true } = {}
) => {
  let inComment = inCommentStart;
  let out = "";
  let i = 0;

  while (i < line.length) {
    if (inComment) {
      const closeIndex = line.indexOf("-->", i);
      if (closeIndex === -1) {
        return { text: out, inComment: true };
      }
      i = closeIndex + 3;
      inComment = false;
      continue;
    }

    if (line[i] === "`") {
      let tickEnd = i;
      while (tickEnd < line.length && line[tickEnd] === "`") tickEnd += 1;
      const tickCount = tickEnd - i;
      const marker = "`".repeat(tickCount);
      let search = tickEnd;
      let closing = -1;
      while (search < line.length) {
        const candidate = line.indexOf(marker, search);
        if (candidate === -1) break;
        const beforeOk = candidate === 0 || line[candidate - 1] !== "`";
        const afterOk =
          candidate + tickCount >= line.length ||
          line[candidate + tickCount] !== "`";
        if (beforeOk && afterOk) {
          closing = candidate;
          break;
        }
        search = candidate + 1;
      }
      if (closing !== -1) {
        out += line.slice(i, closing + tickCount);
        i = closing + tickCount;
        continue;
      }
      out += line.slice(i, tickEnd);
      i = tickEnd;
      continue;
    }

    if (line.startsWith("<!--", i)) {
      if (!allowUnclosed) {
        const closeIndex = line.indexOf("-->", i + 4);
        if (closeIndex === -1) {
          out += line.slice(i);
          break;
        }
        i = closeIndex + 3;
        continue;
      }
      inComment = true;
      i += 4;
      continue;
    }

    out += line[i];
    i += 1;
  }

  return { text: out, inComment };
};

// Per GFM §5.2:
// - Inside a paragraph, only a non-empty list item (unordered or ordered
//   starting with `1`) can interrupt it; bare markers like `+` or `*` cannot.
// - At the parent container level (indentation less than the open list item's
//   content indent), ANY list marker (even an empty one like `*` or `-`)
//   closes the current item and starts a sibling item or new list.
const listItemOpenPattern = /^( {0,3})([-*+]|[0-9]{1,9}[.)])([ \t]+)(\S.*)$/;
const anyListMarkerPattern = /^( {0,3})(?:[-*+]|[0-9]{1,9}[.)])(?:[ \t]|$)/;
const listItemStartPattern = /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/;
const blockquoteStartPattern = /^ {0,3}>/;

const advanceColumn = (column, ch) =>
  ch === "\t" ? column + (4 - (column % 4)) : column + 1;

const computeListContentIndent = (line) => {
  const match = listItemOpenPattern.exec(line);
  if (!match) return null;
  let col = 0;
  for (const ch of match[1]) {
    col = advanceColumn(col, ch);
  }
  col += match[2].length;
  const afterMarkerCol = col;
  for (const ch of match[3]) {
    col = advanceColumn(col, ch);
  }
  const spacesAfter = col - afterMarkerCol;
  // Per GFM §2.2 & §5.2, tabs expand to 4-column tab stops, and 5+ columns of
  // space after the marker starts an indented code block with content indent
  // at `afterMarkerCol + 1`.
  return spacesAfter >= 5 ? afterMarkerCol + 1 : col;
};

const stripUpToColumns = (line, maxColumns) => {
  let col = 0;
  let index = 0;
  while (index < line.length && col < maxColumns) {
    const ch = line[index];
    if (ch === " ") {
      col += 1;
      index += 1;
      continue;
    }
    if (ch === "\t") {
      const nextCol = col + (4 - (col % 4));
      if (nextCol > maxColumns) {
        return `${" ".repeat(nextCol - maxColumns)}${line.slice(index + 1)}`;
      }
      col = nextCol;
      index += 1;
      continue;
    }
    break;
  }
  return line.slice(index);
};

const interruptsParagraph = (line, isBlank, listContentIndent) => {
  if (isBlank) return true;
  if (listContentIndent !== null) {
    const markerMatch = anyListMarkerPattern.exec(line);
    if (markerMatch && markerMatch[1].length < listContentIndent) {
      return true;
    }
  }
  const candidate =
    listContentIndent !== null
      ? stripUpToColumns(line, listContentIndent)
      : line;
  if (
    anyHeadingPattern.test(candidate) ||
    thematicBreakPattern.test(candidate) ||
    blockquoteStartPattern.test(candidate)
  ) {
    return true;
  }
  const fenceMatch = fenceOpenPattern.exec(candidate);
  if (
    fenceMatch &&
    (fenceMatch[1][0] !== "`" ||
      !candidate.slice(fenceMatch[0].length).includes("`"))
  ) {
    return true;
  }
  if (matchHtmlBlockStart(candidate, true) !== null) {
    return true;
  }
  if (listItemStartPattern.test(candidate)) {
    return true;
  }
  return false;
};

const scanVisibleLines = (lines) => {
  const visible = [];
  let fenceChar = "";
  let fenceLength = 0;
  let previousBlank = true;
  let inParagraph = false;
  let listContentIndent = null;
  let inIndentedCode = false;
  let htmlBlock = null;
  let inInlineComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isBlank = /^[ \t]*$/.test(line);

    if (fenceChar) {
      const closePattern = new RegExp(
        `^ {0,3}${fenceChar}{${fenceLength},}[ \\t]*$`
      );
      if (closePattern.test(line)) {
        fenceChar = "";
        fenceLength = 0;
        previousBlank = false;
      }
      inParagraph = false;
      listContentIndent = null;
      visible.push({
        index,
        line,
        visibleLine: "",
        hidden: true,
        hiddenKind: "fence",
      });
      continue;
    }

    if (htmlBlock) {
      if (htmlBlock.endOnBlank && isBlank) {
        htmlBlock = null;
        previousBlank = true;
        inParagraph = false;
        listContentIndent = null;
        visible.push({
          index,
          line,
          visibleLine: "",
          hidden: false,
          hiddenKind: "",
        });
        continue;
      }
      const hiddenKind = htmlBlock.kind;
      if (htmlBlock.endPattern && htmlBlock.endPattern.test(line)) {
        htmlBlock = null;
      }
      previousBlank = isBlank;
      inParagraph = false;
      listContentIndent = null;
      visible.push({
        index,
        line,
        visibleLine: "",
        hidden: true,
        hiddenKind,
      });
      continue;
    }

    if (inInlineComment) {
      // Setext underlines close the open paragraph at the block-parsing stage
      // (GFM §4.3), terminating any unclosed inline comment before the next
      // block (such as a type-7 HTML block) begins.
      if (setextUnderlinePattern.test(line)) {
        inInlineComment = false;
        inParagraph = false;
        listContentIndent = null;
        previousBlank = false;
        visible.push({
          index,
          line,
          visibleLine: "",
          hidden: false,
          hiddenKind: "",
        });
        continue;
      }
      // Inline comments cannot cross a Markdown block boundary (GFM parses
      // block structure before inlines). If this line ends or interrupts the
      // open paragraph (or starts a sibling list item outside the open list
      // item's content indent), abandon the unclosed inline comment and parse
      // this line as its own block.
      if (interruptsParagraph(line, isBlank, listContentIndent)) {
        inInlineComment = false;
        inParagraph = false;
        listContentIndent = null;
      } else {
        const stripped = stripInlineHtmlComments(line, true);
        inInlineComment = stripped.inComment;
        const blankAfter = /^[ \t]*$/.test(stripped.text);
        previousBlank = false;
        inParagraph = true;
        visible.push({
          index,
          line,
          visibleLine: stripped.text,
          hidden: blankAfter,
          hiddenKind: blankAfter ? "html-comment" : "",
        });
        continue;
      }
    }

    const fenceMatch = fenceOpenPattern.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      // Backtick info strings cannot contain backticks in GFM.
      if (
        marker[0] !== "`" ||
        !line.slice(fenceMatch[0].length).includes("`")
      ) {
        fenceChar = marker[0];
        fenceLength = marker.length;
        inIndentedCode = false;
        previousBlank = false;
        inParagraph = false;
        listContentIndent = null;
        visible.push({
          index,
          line,
          visibleLine: "",
          hidden: true,
          hiddenKind: "fence",
        });
        continue;
      }
    }

    if (isBlank) {
      previousBlank = true;
      inParagraph = false;
      listContentIndent = null;
      visible.push({
        index,
        line,
        visibleLine: "",
        hidden: inIndentedCode,
        hiddenKind: inIndentedCode ? "indented-code" : "",
      });
      continue;
    }

    if (
      (previousBlank || inIndentedCode) &&
      indentedCodeLinePattern.test(line)
    ) {
      inIndentedCode = true;
      previousBlank = false;
      inParagraph = false;
      listContentIndent = null;
      visible.push({
        index,
        line,
        visibleLine: "",
        hidden: true,
        hiddenKind: "indented-code",
      });
      continue;
    }

    inIndentedCode = false;

    const matchedHtml = matchHtmlBlockStart(line, inParagraph);
    if (matchedHtml) {
      const endsOnSameLine =
        matchedHtml.endPattern && matchedHtml.endPattern.test(line);
      if (!endsOnSameLine) {
        htmlBlock = matchedHtml;
      }
      previousBlank = false;
      inParagraph = false;
      listContentIndent = null;
      visible.push({
        index,
        line,
        visibleLine: "",
        hidden: true,
        hiddenKind: matchedHtml.kind,
      });
      continue;
    }

    // Setext heading underlines close the preceding paragraph (GFM §4.3), and
    // ATX headings / thematic breaks do not open a paragraph, so a standalone
    // GFM type-7 HTML tag on the immediately following line starts an HTML
    // block. Test the raw line because GFM resolves block structure before
    // inline HTML comments (so `=== <!-- note -->` stays paragraph text).
    const closesSetextHeading =
      inParagraph && setextUnderlinePattern.test(line);
    const continuesParagraph =
      !closesSetextHeading &&
      !anyHeadingPattern.test(line) &&
      !thematicBreakPattern.test(line);
    const openedListIndent = continuesParagraph
      ? computeListContentIndent(line)
      : null;
    if (!continuesParagraph) {
      listContentIndent = null;
    } else if (openedListIndent !== null) {
      listContentIndent = openedListIndent;
    }
    const stripped = stripInlineHtmlComments(line, false, {
      allowUnclosed: continuesParagraph,
    });
    inInlineComment = continuesParagraph && stripped.inComment;
    previousBlank = false;
    inParagraph = continuesParagraph;
    visible.push({
      index,
      line,
      visibleLine: stripped.text,
      hidden: false,
      hiddenKind: "",
    });
  }

  return visible;
};

const isVisibleSectionHeading = (entry) =>
  !entry.hidden &&
  sectionHeadingPattern.test(stripClosingAtxHashes(entry.visibleLine));

const isVisibleAnyHeading = (entry) =>
  !entry.hidden && anyHeadingPattern.test(entry.visibleLine);

export const parsePrBodyE2EFlows = (body) => {
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const scanned = scanVisibleLines(lines);
  const headingIndices = [];

  for (const entry of scanned) {
    if (isVisibleSectionHeading(entry)) {
      headingIndices.push(entry.index);
    }
  }

  if (headingIndices.length === 0) {
    return {
      ok: false,
      error: `Missing \`## E2E flows\` section in the PR description. ${validFlowListMessage()}`,
    };
  }
  if (headingIndices.length > 1) {
    return {
      ok: false,
      error:
        "Found more than one `## E2E flows` section in the PR description; keep exactly one.",
    };
  }

  const start = headingIndices[0] + 1;
  let end = lines.length;
  for (let index = start; index < scanned.length; index += 1) {
    const entry = scanned[index];
    if (isVisibleAnyHeading(entry)) {
      end = index;
      break;
    }
  }

  const tokens = [];

  for (let index = start; index < end; index += 1) {
    const entry = scanned[index];
    if (entry.hidden) {
      if (entry.hiddenKind === "html-comment") {
        continue;
      }
      if (
        entry.hiddenKind === "indented-code" &&
        /^[ \t]*$/.test(entry.line)
      ) {
        continue;
      }
      if (entry.hiddenKind === "indented-code") {
        return {
          ok: false,
          error: `Invalid indented line in \`## E2E flows\`: "${entry.line.trim()}". Use top-level bullet items like \`- admin\`, \`- all\`, or \`- none\`.`,
        };
      }
      if (entry.hiddenKind === "fence") {
        return {
          ok: false,
          error:
            "Code blocks are not allowed inside `## E2E flows`. Use top-level bullet items like `- admin`, `- all`, or `- none`.",
        };
      }
      return {
        ok: false,
        error: `Raw HTML is not allowed inside \`## E2E flows\`: "${entry.line.trim()}". Use top-level bullet items like \`- admin\`, \`- all\`, or \`- none\`.`,
      };
    }
    const rawLine = entry.visibleLine;
    if (/^[ \t]*$/.test(rawLine)) continue;
    if (indentedCodeLinePattern.test(rawLine)) {
      return {
        ok: false,
        error: `Invalid indented line in \`## E2E flows\`: "${rawLine.trim()}". Use top-level bullet items like \`- admin\`, \`- all\`, or \`- none\`.`,
      };
    }
    const line = rawLine.replace(/[ \t]+$/, "");
    const match = bulletPattern.exec(line);
    if (!match) {
      return {
        ok: false,
        error: `Invalid entry in \`## E2E flows\`: "${line.trim()}". Use bullet items like \`- admin\`, \`- all\`, or \`- none\`.`,
      };
    }
    tokens.push(match[1]);
  }

  return parseFlowTokens(tokens);
};

const formatScopeSuffix = (base, selected) => {
  const ordered = sortUniqueFlowIds(selected);
  if (ordered.length === 0) return `${base} [flows: none]`;
  if (ordered.length === WORKSPACE_E2E_FLOW_IDS.length) return base;
  const named = `${base} [flows: ${ordered.join(",")}]`;
  if (named.length <= WORKSPACE_E2E_STATUS_MAX_LENGTH) return named;
  const codes = ordered.map((id) => WORKSPACE_E2E_FLOW_SHORT_CODES[id]);
  return `${base} [codes: ${codes.join(",")}]`;
};

export const formatE2EStatusDescription = ({ kind, flows, sourceSha }) => {
  if (kind === "skipped-none") {
    return "Protected preview E2E skipped [flows: none]";
  }
  const parsed =
    flows === undefined || flows === ""
      ? buildFlowSelection(WORKSPACE_E2E_FLOW_IDS)
      : parseFlowsInput(flows);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (kind === "passed") {
    return formatScopeSuffix("Protected preview E2E passed", parsed.selected);
  }
  if (kind === "restored") {
    return formatScopeSuffix("Protected preview E2E restored", parsed.selected);
  }
  if (kind === "partial") {
    return formatScopeSuffix(
      "Protected preview E2E partial; more flows required",
      parsed.selected
    );
  }
  if (kind === "running") {
    return formatScopeSuffix(
      "Protected preview E2E is running",
      parsed.selected
    );
  }
  if (kind === "failed") {
    return formatScopeSuffix("Protected preview E2E failed", parsed.selected);
  }
  if (kind === "same-tree-passed") {
    const shortSha = String(sourceSha ?? "").slice(0, 7);
    if (!/^[0-9a-f]{7}$/.test(shortSha)) {
      throw new Error("Invalid sourceSha for same-tree status description");
    }
    return formatScopeSuffix(
      `Same tree as ${shortSha}, which passed E2E`,
      parsed.selected
    );
  }
  throw new Error(`Unsupported status description kind: ${kind}`);
};

const parseScopeTag = (tag) => {
  if (!tag) return [...WORKSPACE_E2E_FLOW_IDS];
  const flowsMatch = /^\[flows:\s*([^\]]+)\]$/.exec(tag);
  if (flowsMatch) {
    const parsed = parseFlowsInput(flowsMatch[1]);
    return parsed.ok ? parsed.selected : null;
  }
  const codesMatch = /^\[codes:\s*([^\]]+)\]$/.exec(tag);
  if (codesMatch) {
    const codes = codesMatch[1].split(",").map((part) => part.trim());
    if (
      codes.length === 0 ||
      codes.some((code) => !flowIdByShortCode.has(code))
    ) {
      return null;
    }
    return sortUniqueFlowIds(codes.map((code) => flowIdByShortCode.get(code)));
  }
  return null;
};

const statusPatterns = [
  {
    kind: "passed",
    pattern:
      /^Protected preview E2E passed(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "restored",
    pattern:
      /^Protected preview E2E restored(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "partial",
    pattern:
      /^Protected preview E2E partial; more flows required(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "running",
    pattern:
      /^Protected preview E2E is running(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "failed",
    pattern:
      /^Protected preview E2E failed(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
  {
    kind: "carried-passed",
    pattern:
      /^Same tree as ([0-9a-f]{7}), which passed E2E(?:\s+(\[(?:flows|codes):[^\]]+\]))?$/,
  },
];

export const classifyE2EStatusDescription = (description) => {
  const text = String(description ?? "");
  if (text === WORKSPACE_E2E_SUPERSEDED_DESCRIPTION) {
    return { kind: "superseded" };
  }
  if (text === "Protected preview E2E skipped [flows: none]") {
    return { kind: "skipped-none", selected: [] };
  }
  for (const { kind, pattern } of statusPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (kind === "carried-passed") {
      const selected = parseScopeTag(match[2]);
      if (selected === null) return { kind: "other" };
      return { kind, selected, sourceSha: match[1] };
    }
    const selected = parseScopeTag(match[1]);
    if (selected === null) return { kind: "other" };
    return { kind, selected };
  }
  return { kind: "other" };
};

export const unionFlowIds = (...lists) =>
  sortUniqueFlowIds(lists.flatMap((list) => list));

export const diffFlowIds = (requested, covered) => {
  const coveredSet = new Set(covered);
  return sortUniqueFlowIds(requested).filter((id) => !coveredSet.has(id));
};

export const summarizeCommitStatuses = (
  statuses,
  {
    context = "Workspace E2E",
    creator = "github-actions[bot]",
    includeCarried = false,
  } = {}
) => {
  const relevant = (Array.isArray(statuses) ? statuses : []).filter(
    (status) =>
      status &&
      status.context === context &&
      status.creator?.login === creator
  );

  const latest = relevant[0] ?? null;
  let latestRunKind = null;
  let latestRunState = null;
  const runningFlowIds = [];
  const activeRuns = [];
  let runningDescription = "";
  let runningTargetUrl = "";
  // Track run URLs that have already reached a terminal or superseded status
  // above this point in history so their earlier `running` statuses are not
  // treated as still active, while an active run whose flows are NOT yet
  // decided stays active even when another flow's status was posted above it.
  const terminatedRunUrls = new Set();
  let unscopedSupersededSeen = false;
  // Compute real head-SHA verdicts (`passed`, `partial`, active `running`,
  // `failed`) independently of any carried (`same-tree-passed`) statuses so a
  // carried status above a real failure or active rerun can never hide it.
  // Track carried flows per source SHA so filtering out head-failed/running
  // flows retains accurate provenance and never cites a commit for flows it
  // did not pass.
  const realDecidedFlows = new Set();
  const realPassedFlowIds = [];
  const carriedSourcesOrder = [];
  const carriedFlowsBySource = new Map();
  const failedFlowIds = [];

  for (const status of relevant) {
    const classified = classifyE2EStatusDescription(status.description);
    const targetUrl = String(status.target_url ?? "");

    // Any non-pending status emitted by a workflow run terminates that run's
    // earlier `running` entry, even when the final status reports a metadata
    // or infrastructure failure (`kind: "other"`).
    if (status.state !== "pending" && targetUrl) {
      terminatedRunUrls.add(targetUrl);
    }

    if (classified.kind === "superseded") {
      if (!targetUrl) {
        unscopedSupersededSeen = true;
      }
      if (latestRunKind === null) {
        latestRunKind = "superseded";
        latestRunState = "superseded";
      }
      continue;
    }
    if (
      (classified.kind === "passed" && status.state === "success") ||
      (classified.kind === "partial" && status.state === "failure")
    ) {
      if (latestRunKind === null) {
        latestRunKind = classified.kind;
        latestRunState = status.state;
      }
      for (const flow of classified.selected) {
        if (!realDecidedFlows.has(flow)) {
          realDecidedFlows.add(flow);
          realPassedFlowIds.push(flow);
        }
      }
      continue;
    }
    // Restored statuses mirror earlier real runs and are never themselves
    // authoritative proof of a real run result.
    if (classified.kind === "restored") {
      continue;
    }
    if (
      includeCarried &&
      classified.kind === "carried-passed" &&
      status.state === "success"
    ) {
      if (latestRunKind === null) {
        latestRunKind = "carried-passed";
        latestRunState = "success";
      }
      const sourceSha = classified.sourceSha ?? "";
      if (sourceSha) {
        let sourceFlows = carriedFlowsBySource.get(sourceSha);
        if (!sourceFlows) {
          sourceFlows = new Set();
          carriedFlowsBySource.set(sourceSha, sourceFlows);
          carriedSourcesOrder.push(sourceSha);
        }
        for (const flow of classified.selected) {
          sourceFlows.add(flow);
        }
      }
      continue;
    }
    if (classified.kind === "running" && status.state === "pending") {
      const isTerminated = targetUrl
        ? terminatedRunUrls.has(targetUrl)
        : unscopedSupersededSeen;
      if (isTerminated) {
        continue;
      }
      const activeFlows = classified.selected.filter(
        (flow) => !realDecidedFlows.has(flow)
      );
      if (activeFlows.length > 0) {
        if (latestRunKind === null) {
          latestRunKind = "running";
          latestRunState = "pending";
        }
        if (!runningDescription) {
          runningDescription = String(status.description ?? "");
          runningTargetUrl = targetUrl;
        }
        activeRuns.push({
          description: String(status.description ?? ""),
          targetUrl,
          flows: activeFlows,
        });
        for (const flow of activeFlows) {
          realDecidedFlows.add(flow);
          runningFlowIds.push(flow);
        }
      }
      continue;
    }
    if (
      classified.kind === "failed" &&
      (status.state === "failure" || status.state === "error")
    ) {
      if (targetUrl) {
        terminatedRunUrls.add(targetUrl);
      }
      if (latestRunKind === null) {
        latestRunKind = "failed";
        latestRunState = status.state;
      }
      for (const flow of classified.selected) {
        if (!realDecidedFlows.has(flow)) {
          realDecidedFlows.add(flow);
          failedFlowIds.push(flow);
        }
      }
    }
  }

  // Never let carried coverage include any flow that failed or is actively
  // running on the head SHA itself, and retain each surviving flow's source.
  const headBlockedSet = new Set([...failedFlowIds, ...runningFlowIds]);
  const carriedSources = [];
  for (const sourceSha of carriedSourcesOrder) {
    const surviving = sortUniqueFlowIds(
      [...(carriedFlowsBySource.get(sourceSha) ?? [])].filter(
        (flow) => !headBlockedSet.has(flow)
      )
    );
    if (surviving.length > 0) {
      const built = buildFlowSelection(surviving);
      carriedSources.push({
        sourceSha,
        flows: built.selected,
        flowsCsv: built.flows,
      });
    }
  }
  const carriedSourceSha = carriedSources[0]?.sourceSha ?? "";
  const carriedPassedFlowIds = unionFlowIds(
    ...carriedSources.map((entry) => entry.flows)
  );

  const realPassed = buildFlowSelection(realPassedFlowIds);
  const carriedPassed = buildFlowSelection(carriedPassedFlowIds);
  const failed = buildFlowSelection(failedFlowIds);
  const allPassed = buildFlowSelection([
    ...realPassedFlowIds,
    ...carriedPassedFlowIds,
  ]);
  const running = buildFlowSelection(runningFlowIds);
  const coverageSource =
    realPassed.selected.length > 0 && carriedPassedFlowIds.length === 0
      ? "real"
      : carriedPassedFlowIds.length > 0
        ? "carried"
        : "none";

  return {
    latestState: latest?.state ?? "",
    latestDescription: latest?.description ?? "",
    latestKind: latest
      ? classifyE2EStatusDescription(latest.description).kind
      : "",
    latestRunKind: latestRunKind ?? "",
    latestRunState: latestRunState ?? "",
    passedFlows: allPassed.selected,
    passedFlowsCsv: allPassed.flows,
    realPassedFlows: realPassed.selected,
    realPassedFlowsCsv: realPassed.flows,
    carriedPassedFlows: carriedPassed.selected,
    carriedPassedFlowsCsv: carriedPassed.flows,
    carriedSources,
    failedFlows: failed.selected,
    failedFlowsCsv: failed.flows,
    carriedSourceSha,
    coverageSource,
    runningFlows: running.selected,
    runningFlowsCsv: running.flows,
    runningDescription,
    runningTargetUrl,
    activeRuns,
    anyPassed: allPassed.selected.length > 0,
  };
};

export const findCoveringCarriedSource = (
  carriedSources,
  requestedSelected
) => {
  if (
    !Array.isArray(carriedSources) ||
    carriedSources.length === 0 ||
    !Array.isArray(requestedSelected) ||
    requestedSelected.length === 0
  ) {
    return null;
  }
  return (
    carriedSources.find(
      (entry) =>
        Boolean(entry?.sourceSha) &&
        diffFlowIds(requestedSelected, entry.flows ?? []).length === 0
    ) ?? null
  );
};
