import { Schema } from "effect";
import { type Resolver, type SubmitHandler, useForm } from "react-hook-form";
import { effectSchemaResolver } from "./index";

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

const schema = Schema.Struct({ age: Schema.FiniteFromString });
const resolver = effectSchemaResolver(schema);
const rawResolver = effectSchemaResolver(schema, undefined, { raw: true });

type Encoded = { readonly age: string };
type Decoded = { readonly age: number };

export type DecodedResolver = Expect<
  Equal<typeof resolver, Resolver<Encoded, unknown, Decoded>>
>;
export type RawResolver = Expect<
  Equal<typeof rawResolver, Resolver<Encoded, unknown, Encoded>>
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
