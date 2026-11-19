// ISSUE-95 fixture: the accepted counterparts. Narrowing replaces `any`, and
// every promise is awaited or otherwise handled.

async function work(): Promise<void> {
  await Promise.resolve();
}

export function narrowed(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function awaited(): Promise<void> {
  try {
    await work();
  } catch (error) {
    void error;
  }
}
