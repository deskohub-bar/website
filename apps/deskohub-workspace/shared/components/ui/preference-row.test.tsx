import { describe, expect, test } from "bun:test";
import { Predicate } from "effect";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreferenceRow } from "./preference-row";

// A custom control whose class list mixes classes with entries clsx skips;
// the row hands it back the joined string.
function MixedClassControl({
  className,
}: {
  readonly className?: string | readonly (string | (() => number))[];
}) {
  return (
    <button
      className={Predicate.isString(className) ? className : undefined}
      type="button"
    />
  );
}

const renderedControlClass = (control: ReactNode) =>
  renderToStaticMarkup(
    <PreferenceRow
      control={control}
      description="Description"
      descriptionId="row-description"
      title="Title"
      titleId="row-title"
    />
  ).match(/<button[^>]*class="([^"]*)"/)?.[1];

describe("preference row control", () => {
  test("keeps the control's classes beside the shrink guard", () => {
    expect(
      renderedControlClass(
        <MixedClassControl className={["focus-ring", () => 0]} />
      )
    ).toBe("shrink-0 focus-ring");
    expect(
      renderedControlClass(<MixedClassControl className="focus-ring" />)
    ).toBe("shrink-0 focus-ring");
  });
});
