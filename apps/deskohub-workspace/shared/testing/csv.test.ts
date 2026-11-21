import { describe, expect, test } from "bun:test";
import { parseCsv } from "./csv.test-utils";

describe("parseCsv", () => {
  test("keeps quoted separators, line breaks and empty cells in their original rows", () => {
    expect(
      parseCsv(
        'Name,Details\r\n"Žluťoučký, kůň","line\nbreak\r\nend"\r\n"say ""hi""",\r\n'
      )
    ).toEqual([
      ["Name", "Details"],
      ["Žluťoučký, kůň", "line\nbreak\r\nend"],
      ['say "hi"', ""],
    ]);
  });

  test("drops a leading byte order mark", () => {
    const byteOrderMark = String.fromCodePoint(0xfe_ff);

    expect(parseCsv(`${byteOrderMark}Name\r\nPraha\r\n`)).toEqual([
      ["Name"],
      ["Praha"],
    ]);
  });

  test("refuses text that ends inside a quoted cell", () => {
    expect(() => parseCsv('"open')).toThrow();
  });
});
