/** How the die moves: the full tumble with a hop and a squash on landing, or rolling in place next to text. */
export type LoadingDieMotion = "tumble" | "inPlace";

/** Playback rate and loop length of the loading die documents. */
export interface LoadingDieTiming {
  readonly framesPerSecond: number;
  readonly frameCount: number;
}

export const loadingDieTiming: LoadingDieTiming = {
  framesPerSecond: 60,
  frameCount: 96,
};
