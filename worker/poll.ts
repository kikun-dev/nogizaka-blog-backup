export async function pollOnce<T>(claim: () => Promise<T | null>, run: (item: T) => Promise<void>): Promise<boolean> {
  const item = await claim();
  if (item === null) return false;
  await run(item);
  return true;
}
