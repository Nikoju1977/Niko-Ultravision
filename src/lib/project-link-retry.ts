function errorStatus(error: unknown): number | undefined {
  if (error == null || typeof error !== "object") return undefined;
  const value = "status" in error ? error.status : "statusCode" in error ? error.statusCode : undefined;
  return typeof value === "number" ? value : undefined;
}

/** Retry one transport/server failure, but never replay a rejected client request. */
export async function linkProjectWithOneRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const status = errorStatus(error);
    if (status != null && status >= 400 && status < 500) throw error;
    return operation();
  }
}
