import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type FieldErrors, useForm } from "react-hook-form";
import { Form, FormControl, FormField, FormItem, FormMessage } from "./form";

type ContactValues = { name: string };

function NameMessage({
  errors,
  children,
}: {
  errors?: FieldErrors<ContactValues>;
  children?: ReactNode;
}) {
  const form = useForm<ContactValues>({
    defaultValues: { name: "" },
    errors,
  });
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="name"
        render={() => (
          <FormItem>
            <FormControl>
              <input />
            </FormControl>
            <FormMessage className="text-red-400">{children}</FormMessage>
          </FormItem>
        )}
      />
    </Form>
  );
}

const messageOf = (html: string) => {
  const match = /<p\b[^>]*\bid="([^"]*)"[^>]*>(.*)<\/p>/.exec(html);
  return match && { id: match[1], body: match[2] };
};

describe("FormMessage", () => {
  test("shows the field's error in place of its own content", () => {
    const html = renderToStaticMarkup(
      <NameMessage errors={{ name: { type: "required", message: "Required" } }}>
        Hint
      </NameMessage>
    );
    const message = messageOf(html);
    const describedBy = /<input[^>]*aria-describedby="([^"]*)"/.exec(html)?.[1];

    expect(message?.body).toBe("Required");
    expect(describedBy?.split(" ")).toContain(message?.id);
    expect(html).toContain("text-red-400");
    expect(html).not.toContain("text-destructive");
  });

  test("shows its own content while the field is valid", () => {
    const message = messageOf(
      renderToStaticMarkup(<NameMessage>Hint</NameMessage>)
    );

    expect(message?.body).toBe("Hint");
  });

  test("renders nothing without an error or content", () => {
    const html = renderToStaticMarkup(<NameMessage />);

    expect(html).not.toMatch(/<p\b/);
  });
});
