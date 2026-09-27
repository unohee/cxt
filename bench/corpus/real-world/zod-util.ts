export function assertEqual<A, B>(val: AssertEqual<A, B>): AssertEqual<A, B> {
  return val;
}

export function assertNotEqual<A, B>(val: AssertNotEqual<A, B>): AssertNotEqual<A, B> {
  return val;
}

export function assertIs<T>(_arg: T): void {}

export function assertNever(_x: never): never {
  throw new Error("Unexpected value in exhaustive check");
}
export function assert<T>(_: any): asserts _ is T {}

export function getEnumValues(entries: EnumLike): EnumValue[] {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries)
    .filter(([k, _]) => numericValues.indexOf(+k) === -1)
    .map(([_, v]) => v);
  return values;
}

export function joinValues<T extends Primitive[]>(array: T, separator = "|"): string {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}

export function jsonStringifyReplacer(_: string, value: any): any {
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function cached<T>(getter: () => T): { value: T } {
  const set = false;
  return {
    get value() {
      if (!set) {
        const value = getter();
        Object.defineProperty(this, "value", { value });
        return value;
      }
      throw new Error("cached value already set");
    },
  };
}

export function nullish(input: any): boolean {
  return input === null || input === undefined;
}

export function cleanRegex(source: string): string {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}

export function floatSafeRemainder(val: number, step: number): number {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepString = step.toString();
  let stepDecCount = (stepString.split(".")[1] || "").length;
  if (stepDecCount === 0 && /\d?e-\d?/.test(stepString)) {
    const match = stepString.match(/\d?e-(\d?)/);
    if (match?.[1]) {
      stepDecCount = Number.parseInt(match[1]);
    }
  }

  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return (valInt % stepInt) / 10 ** decCount;
}

const EVALUATING = Symbol("evaluating");
