import { Context, Effect, Schema, SchemaGetter } from "effect";
import { type Resolver, type SubmitHandler, useForm } from "react-hook-form";
import {
  effectSchemaResolver,
  effectSchemaResolverWithServices,
} from "./index";

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

const schema = Schema.Struct({ age: Schema.FiniteFromString });
const resolver = effectSchemaResolver(schema);
const rawResolver = effectSchemaResolver(schema, undefined, { raw: true });

class Clock extends Context.Service<Clock, { readonly offset: number }>()(
  "EffectSchemaResolverTypecheck/Clock"
) {}

const servicesSchema = Schema.Struct({
  age: Schema.String.pipe(
    Schema.decodeTo(Schema.Finite, {
      decode: SchemaGetter.transformEffect((age: string) =>
        Clock.use(({ offset }) => Effect.succeed(Number(age) + offset))
      ),
      encode: SchemaGetter.String(),
    })
  ),
});
const services = Context.make(Clock, { offset: 0 });
const servicesResolver = effectSchemaResolverWithServices(
  servicesSchema,
  services
);
const rawServicesResolver = effectSchemaResolverWithServices(
  servicesSchema,
  services,
  undefined,
  { raw: true }
);

type Encoded = { readonly age: string };
type Decoded = { readonly age: number };

export type DecodedResolver = Expect<
  Equal<typeof resolver, Resolver<Encoded, unknown, Decoded>>
>;
export type RawResolver = Expect<
  Equal<typeof rawResolver, Resolver<Encoded, unknown, Encoded>>
>;

export type DecodedServicesResolver = Expect<
  Equal<typeof servicesResolver, Resolver<Encoded, unknown, Decoded>>
>;
export type RawServicesResolver = Expect<
  Equal<typeof rawServicesResolver, Resolver<Encoded, unknown, Encoded>>
>;

function useInferredForm() {
  const { getValues, handleSubmit } = useForm({ resolver });
  return { age: getValues("age"), handleSubmit };
}

type InferredForm = ReturnType<typeof useInferredForm>;

export type InferredFieldValue = Expect<Equal<InferredForm["age"], string>>;
export type InferredSubmitHandler = Expect<
  Equal<Parameters<InferredForm["handleSubmit"]>[0], SubmitHandler<Decoded>>
>;
