import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Tooltip } from "./tooltip";

const params = new URLSearchParams(location.search);

function Fixture() {
  const [open, setOpen] = useState(params.has("open"));
  const [changes, setChanges] = useState<boolean[]>([]);

  return (
    <>
      <button type="button">Before</button>
      <div style={{ margin: "100px 0 0 150px" }}>
        <Tooltip
          defaultOpen={params.has("defaultOpen")}
          open={params.has("controlled") ? open : undefined}
          delay={120}
          onOpenChange={(nextOpen) => {
            setChanges((previous) => [...previous, nextOpen]);
            if (params.has("controlled") && !params.has("veto")) {
              setTimeout(() => setOpen(nextOpen), 80);
            }
          }}
          trigger={<button type="button">Info</button>}
        >
          Test hint
        </Tooltip>
      </div>
      <button type="button" style={{ margin: 50 }}>
        Outside
      </button>
      {params.has("controlled") && (
        <button type="button" onClick={() => setOpen(!open)}>
          Change open
        </button>
      )}
      <output data-testid="changes">{JSON.stringify(changes)}</output>
      <div data-testid="blank-space" style={{ height: 1000 }} />
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
