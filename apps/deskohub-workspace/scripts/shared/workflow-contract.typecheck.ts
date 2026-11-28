import type {
  CompositeActionDoc,
  WorkflowDoc,
  WorkflowStep,
  WorkflowStepValue,
} from "./workflow-contract";

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Extends<X, Y> = [X] extends [Y] ? true : false;

// A caller's own named step type stays assignable: the parsed contracts
// carry no index signature for the undeclared keys the parser keeps.
interface NamedStep {
  readonly name: string;
}
type _NamedStepIsAStep = Expect<Extends<NamedStep, WorkflowStep>>;

// Step `env` and `with` values are what YAML yields unquoted, not only
// strings, and callers may still fill the maps in place.
type _StepEnv = Expect<
  Equal<NonNullable<WorkflowStep["env"]>, Record<string, WorkflowStepValue>>
>;
type _StepWith = Expect<
  Equal<NonNullable<WorkflowStep["with"]>, Record<string, WorkflowStepValue>>
>;

// A job timeout may be a `${{ }}` expression.
type _JobTimeout = Expect<
  Equal<
    NonNullable<WorkflowDoc["jobs"][string]["timeout-minutes"]>,
    number | string
  >
>;

type _CompositeStepsAreSteps = Expect<
  Equal<CompositeActionDoc["runs"]["steps"], readonly WorkflowStep[]>
>;
