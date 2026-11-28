import { describe, expect, test } from "bun:test";
import * as SelectPrimitive from "@radix-ui/react-select";
import { findElementsOfType } from "@/shared/testing/react-element-tree";
import { SelectContent, SelectItem } from "./select";

describe("SelectContent", () => {
  test("puts options in the menu and honors its positioning", () => {
    const menu = SelectContent({
      children: <SelectItem value="10:00">10:00</SelectItem>,
    });
    const [defaultContent] = findElementsOfType(menu, SelectPrimitive.Content);
    const [itemAlignedContent] = findElementsOfType(
      SelectContent({ position: "item-aligned" }),
      SelectPrimitive.Content
    );

    expect(defaultContent?.props.position).toBe("popper");
    expect(itemAlignedContent?.props.position).toBe("item-aligned");

    const [viewport] = findElementsOfType(menu, SelectPrimitive.Viewport);
    expect(
      findElementsOfType(viewport, SelectItem).map(({ props }) => ({
        value: props.value,
        label: props.children,
      }))
    ).toEqual([{ value: "10:00", label: "10:00" }]);
  });
});
