const prefix = "workspace-open-space-move:";
const markerPattern =
  /^workspace-open-space-move:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const formatOpenSpaceMoveMarker = (generation: string) =>
  `${prefix}${generation}`;

const isOpenSpaceMoveMarker = (line: string) => markerPattern.test(line);

export const hasOpenSpaceMoveMarker = (note: string | null | undefined) =>
  note?.split("\n").some(isOpenSpaceMoveMarker) ?? false;

export const withoutOpenSpaceMoveMarkers = (note: string | null | undefined) =>
  (note ?? "").split("\n").filter((line) => !isOpenSpaceMoveMarker(line));
