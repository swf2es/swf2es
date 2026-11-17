/** Device/constraint failures say nothing about the user's permission decision. */
export function denied(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError";
}

export async function openMedia(
  media: MediaDevices,
  constraints: MediaStreamConstraints,
  fallback: MediaStreamConstraints,
  signal: AbortSignal,
): Promise<MediaStream> {
  try {
    return await media.getUserMedia(constraints);
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? error.name : "";
    if (signal.aborted || (name !== "OverconstrainedError" && name !== "NotFoundError")) {
      throw error;
    }

    // Device IDs and native modes can change after enumeration. Keep preferences, not demands.
    return media.getUserMedia(fallback);
  }
}
