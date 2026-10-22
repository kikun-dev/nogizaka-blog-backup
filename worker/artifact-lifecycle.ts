import type { ArtifactInput } from "../server/public-store";

// If the response is lost after a successful DB commit, deletion would break
// already published downloads. R2's one-day lifecycle removes uncertain uploads.
export async function finishUploadedArtifacts(commit: () => Promise<boolean>, uploaded: ArtifactInput[]): Promise<boolean> {
  try {
    const committed = await commit();
    if (committed) uploaded.length = 0;
    return committed;
  } catch (error) {
    uploaded.length = 0;
    throw error;
  }
}
