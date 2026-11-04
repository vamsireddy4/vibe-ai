export function isEdgeFunctionUnavailable(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("failed to send a request to the edge function") ||
    message.includes("edge function returned a non-2xx status code") ||
    message.includes("functionsfetcherror") ||
    message.includes("network request failed") ||
    message.includes("failed to fetch") ||
    message.includes("clone project is missing") ||
    message.includes("not deployed on the clone project")
  );
}

export function getErrorMessage(error: unknown, fallback = "Unknown error") {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

export function getFunctionUnavailableMessage(action: string) {
  return `${action} is not available because the required Supabase Edge Function is not deployed or reachable for this project yet.`;
}

// supabase-js wraps non-2xx responses in FunctionsHttpError with a generic
// "Edge Function returned a non-2xx status code" message and the raw Response
// on `.context`. Read that body so callers can show the function's real error
// instead of a misleading "function not deployed" fallback.
export async function extractEdgeFunctionError(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown })?.context as Response | undefined;
  if (!context || typeof context.text !== "function") return null;
  try {
    const text = await context.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        const errField = (parsed as { error?: unknown }).error;
        const detailsField = (parsed as { details?: unknown }).details;
        if (errField) {
          return typeof detailsField === "string" && detailsField ? `${String(errField)}: ${detailsField}` : String(errField);
        }
        const msgField = (parsed as { message?: unknown }).message;
        if (msgField) return String(msgField);
      }
      return text;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}
