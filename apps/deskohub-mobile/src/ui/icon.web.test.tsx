import { describe, expect, spyOn, test } from "bun:test";
import { Platform } from "react-native";
import { clientRoot } from "../testing/client-root";
import { Icon, type IconComponent } from "./icon";

const root = clientRoot();
// On the web, react-native-svg passes the Lucide glyph's props to a DOM SVG.
const WebGlyph: IconComponent = (props) => <svg {...props} />;

describe("Icon on the web", () => {
  test("hides the icon with attributes the DOM accepts, so React logs no warning", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    const platform = Platform as { OS: string };
    const os = platform.OS;
    try {
      platform.OS = "web";
      await root.render(<Icon icon={WebGlyph} />);
      expect(errors).not.toHaveBeenCalled();
      expect(
        root.container().querySelector("svg")?.getAttribute("aria-hidden")
      ).toBe("true");
    } finally {
      platform.OS = os;
      errors.mockRestore();
    }
  });
});
