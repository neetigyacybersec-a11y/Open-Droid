// ISSUE-95 fixture: every construct below must be rejected by the real ESLint
// configuration. This file is intentionally invalid and is never imported.

async function work(): Promise<void> {
  await Promise.resolve();
}

export function floating(): void {
  work();
}

export function misused(): void {
  if (work()) {
    return;
  }
}

export function explicitAny(value: unknown): unknown {
  const copy: any = value;
  return copy;
}

export function unnecessaryAssertion(value: string): string {
  return value!;
}
