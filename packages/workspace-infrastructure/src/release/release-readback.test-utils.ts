import type { ImageDigest } from "../config/stack-config";
import type { ReleaseWorker, TrafficReadback } from "./release-reconciler";

/** Both workers ready and serving one image, as settlement reads them. */
export const workersServing = (
  imageDigest: ImageDigest | null
): Readonly<Record<ReleaseWorker, TrafficReadback>> => ({
  "tasks-worker": {
    servingRevision: "workspace-tasks-worker-00001",
    servingImageDigest: imageDigest,
    trafficGeneration: null,
  },
  "scheduler-worker": {
    servingRevision: "workspace-scheduler-worker-00001",
    servingImageDigest: imageDigest,
    trafficGeneration: null,
  },
});
