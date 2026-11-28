/**
 * The subset of the Lottie (Bodymovin) format the loading die documents use,
 * and sampling of it the way a Lottie player interpolates: linear between
 * keys, hold keys keep their value until the next key.
 */

import { Schema } from "effect";
import type { Point } from "./geometry";

/** A closed path: vertices with in and out tangents relative to them. */
export interface LottieShape {
  readonly c: true;
  readonly v: readonly Point[];
  readonly i: readonly Point[];
  readonly o: readonly Point[];
}

interface LottieEasing {
  readonly x: number;
  readonly y: number;
}

/** A key: linear to the next key when it carries easing, held when `h` is 1; the last key carries neither. */
export interface LottieKeyframe<Value> {
  readonly t: number;
  readonly s: Value;
  readonly h?: 1;
  readonly o?: LottieEasing;
  readonly i?: LottieEasing;
}

/** A property that is either static (`k` is the value) or keyed (`k` lists keys whose `s` wraps the value). */
export type LottieProperty<Static, Keyed> =
  | { readonly a: 0; readonly k: Static }
  | { readonly a: 1; readonly k: readonly LottieKeyframe<Keyed>[] };

export type ShapeProperty = LottieProperty<LottieShape, readonly [LottieShape]>;
export type ScalarProperty = LottieProperty<number, readonly [number]>;
export type VectorProperty = LottieProperty<
  readonly number[],
  readonly number[]
>;

export interface FaceGroup {
  readonly ty: "gr";
  readonly nm: string;
  readonly it: readonly [
    { readonly ty: "sh"; readonly nm: string; readonly ks: ShapeProperty },
    GroupTransform,
  ];
}

interface GroupTransform {
  readonly ty: "tr";
  readonly p: VectorProperty;
  readonly a: VectorProperty;
  readonly s: VectorProperty;
  readonly r: ScalarProperty;
  readonly o: ScalarProperty;
}

export interface GradientFill {
  readonly ty: "gf";
  readonly nm: string;
  readonly o: ScalarProperty;
  readonly r: 1;
  readonly bm: 0;
  /** Linear gradient. */
  readonly t: 1;
  readonly s: VectorProperty;
  readonly e: VectorProperty;
  /** `p` stops of offset, red, green, blue (0 to 1). */
  readonly g: { readonly p: number; readonly k: VectorProperty };
}

export interface SolidFill {
  readonly ty: "fl";
  readonly nm: string;
  readonly o: ScalarProperty;
  readonly c: VectorProperty;
  readonly r: 1;
  readonly bm: 0;
}

interface LayerTransform {
  readonly o: ScalarProperty;
  readonly r: ScalarProperty;
  readonly p:
    | VectorProperty
    | {
        readonly s: true;
        readonly x: ScalarProperty;
        readonly y: ScalarProperty;
      };
  readonly a: VectorProperty;
  readonly s: VectorProperty;
}

interface LayerTiming {
  readonly ddd: 0;
  readonly ind: number;
  readonly nm: string;
  readonly sr: 1;
  readonly ao: 0;
  readonly ip: number;
  readonly op: number;
  readonly st: 0;
  readonly bm: 0;
}

/** The parent null layer carrying the hop (position) and squash (scale) about the die's base. */
export interface HopLayer extends LayerTiming {
  readonly ty: 3;
  readonly ks: LayerTransform & {
    readonly p: {
      readonly s: true;
      readonly x: ScalarProperty;
      readonly y: ScalarProperty;
    };
  };
}

/** The shape layer: twenty face groups, then the fill named "tint". */
export interface DieLayer extends LayerTiming {
  readonly ty: 4;
  readonly parent: number;
  readonly ks: LayerTransform;
  readonly shapes: readonly (FaceGroup | GradientFill | SolidFill)[];
}

/** A loading die document, exported as the public `LottieDocument`. */
export type LoadingDieLottie = {
  readonly v: string;
  readonly nm: string;
  readonly fr: number;
  readonly ip: number;
  readonly op: number;
  readonly w: number;
  readonly h: number;
  readonly ddd: 0;
  readonly assets: readonly never[];
  readonly layers: readonly [HopLayer, DieLayer];
};

export const linearEasing = {
  o: { x: 0, y: 0 },
  i: { x: 1, y: 1 },
} as const;

const sampleKeys = <Value>(
  keys: readonly LottieKeyframe<Value>[],
  frame: number,
  interpolate: (from: Value, to: Value, progress: number) => Value
): Value => {
  const first = keys[0];
  if (first === undefined) {
    throw new Error("A keyed property has no keys.");
  }
  if (frame <= first.t) {
    return first.s;
  }
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const next = keys[index + 1];
    if (key === undefined) {
      break;
    }
    if (next === undefined) {
      return key.s;
    }
    if (frame < next.t) {
      return key.h === 1
        ? key.s
        : interpolate(key.s, next.s, (frame - key.t) / (next.t - key.t));
    }
  }
  throw new Error("Unreachable: the last key returns.");
};

const lerp = (from: number, to: number, progress: number) =>
  from + (to - from) * progress;

const lerpPoints = (
  from: readonly Point[],
  to: readonly Point[],
  progress: number
): Point[] =>
  from.map((point, index) => {
    const target = to[index] ?? point;
    return [
      lerp(point[0], target[0], progress),
      lerp(point[1], target[1], progress),
    ];
  });

export const sampleScalar = (property: ScalarProperty, frame: number) =>
  property.a === 0
    ? property.k
    : sampleKeys(property.k, frame, (from, to, progress): readonly [number] => [
        lerp(from[0], to[0], progress),
      ])[0];

export const sampleVector = (
  property: VectorProperty,
  frame: number
): readonly number[] =>
  property.a === 0
    ? property.k
    : sampleKeys(property.k, frame, (from, to, progress) =>
        from.map((value, index) => lerp(value, to[index] ?? value, progress))
      );

export const sampleShape = (
  property: ShapeProperty,
  frame: number
): LottieShape =>
  property.a === 0
    ? property.k
    : sampleKeys(
        property.k,
        frame,
        (from, to, progress): readonly [LottieShape] => [
          {
            c: true,
            v: lerpPoints(from[0].v, to[0].v, progress),
            i: lerpPoints(from[0].i, to[0].i, progress),
            o: lerpPoints(from[0].o, to[0].o, progress),
          },
        ]
      )[0];

const PointSchema = Schema.Tuple([Schema.Finite, Schema.Finite]);

const LottieShapeSchema = Schema.Struct({
  c: Schema.Literal(true),
  v: Schema.Array(PointSchema),
  i: Schema.Array(PointSchema),
  o: Schema.Array(PointSchema),
});

const LottieEasingSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
});

const lottieProperty = <Static extends Schema.Top, Keyed extends Schema.Top>(
  staticValue: Static,
  keyedValue: Keyed
) =>
  Schema.Union([
    Schema.Struct({ a: Schema.Literal(0), k: staticValue }),
    Schema.Struct({
      a: Schema.Literal(1),
      k: Schema.Array(
        Schema.Struct({
          t: Schema.Finite,
          s: keyedValue,
          h: Schema.optionalKey(Schema.Literal(1)),
          o: Schema.optionalKey(LottieEasingSchema),
          i: Schema.optionalKey(LottieEasingSchema),
        })
      ),
    }),
  ]);

const ShapePropertySchema = lottieProperty(
  LottieShapeSchema,
  Schema.Tuple([LottieShapeSchema])
);
const ScalarPropertySchema = lottieProperty(
  Schema.Finite,
  Schema.Tuple([Schema.Finite])
);
const VectorPropertySchema = lottieProperty(
  Schema.Array(Schema.Finite),
  Schema.Array(Schema.Finite)
);

const FaceGroupSchema = Schema.Struct({
  ty: Schema.Literal("gr"),
  nm: Schema.String,
  it: Schema.Tuple([
    Schema.Struct({
      ty: Schema.Literal("sh"),
      nm: Schema.String,
      ks: ShapePropertySchema,
    }),
    Schema.Struct({
      ty: Schema.Literal("tr"),
      p: VectorPropertySchema,
      a: VectorPropertySchema,
      s: VectorPropertySchema,
      r: ScalarPropertySchema,
      o: ScalarPropertySchema,
    }),
  ]),
});

const GradientFillSchema = Schema.Struct({
  ty: Schema.Literal("gf"),
  nm: Schema.String,
  o: ScalarPropertySchema,
  r: Schema.Literal(1),
  bm: Schema.Literal(0),
  t: Schema.Literal(1),
  s: VectorPropertySchema,
  e: VectorPropertySchema,
  g: Schema.Struct({ p: Schema.Finite, k: VectorPropertySchema }),
});

const SolidFillSchema = Schema.Struct({
  ty: Schema.Literal("fl"),
  nm: Schema.String,
  o: ScalarPropertySchema,
  c: VectorPropertySchema,
  r: Schema.Literal(1),
  bm: Schema.Literal(0),
});

const SplitPositionSchema = Schema.Struct({
  s: Schema.Literal(true),
  x: ScalarPropertySchema,
  y: ScalarPropertySchema,
});

const LayerTransformSchema = Schema.Struct({
  o: ScalarPropertySchema,
  r: ScalarPropertySchema,
  p: Schema.Union([VectorPropertySchema, SplitPositionSchema]),
  a: VectorPropertySchema,
  s: VectorPropertySchema,
});

const LayerTimingSchema = Schema.Struct({
  ddd: Schema.Literal(0),
  ind: Schema.Finite,
  nm: Schema.String,
  sr: Schema.Literal(1),
  ao: Schema.Literal(0),
  ip: Schema.Finite,
  op: Schema.Finite,
  st: Schema.Literal(0),
  bm: Schema.Literal(0),
});

const HopLayerSchema = Schema.Struct({
  ...LayerTimingSchema.fields,
  ty: Schema.Literal(3),
  ks: Schema.Struct({ ...LayerTransformSchema.fields, p: SplitPositionSchema }),
});

const DieLayerSchema = Schema.Struct({
  ...LayerTimingSchema.fields,
  ty: Schema.Literal(4),
  parent: Schema.Finite,
  ks: LayerTransformSchema,
  shapes: Schema.Array(
    Schema.Union([FaceGroupSchema, GradientFillSchema, SolidFillSchema])
  ),
});

/**
 * A loading die document as the runtime reads it. The committed documents are
 * generated and checked by loading-die-document.test.ts; checking them
 * against this schema types the JSON import.
 */
export const LoadingDieLottieSchema: Schema.Decoder<LoadingDieLottie> =
  Schema.Struct({
    v: Schema.String,
    nm: Schema.String,
    fr: Schema.Finite,
    ip: Schema.Finite,
    op: Schema.Finite,
    w: Schema.Finite,
    h: Schema.Finite,
    ddd: Schema.Literal(0),
    assets: Schema.Array(Schema.Never),
    layers: Schema.Tuple([HopLayerSchema, DieLayerSchema]),
  });

/** Narrows an imported JSON document to a loading die document, keeping the object itself. */
export const isLoadingDieLottie = Schema.is(LoadingDieLottieSchema);
