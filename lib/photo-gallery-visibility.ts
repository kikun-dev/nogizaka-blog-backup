import type { LocalJob } from "../server/job-store";

export function canShowPhotoGallery(job: LocalJob | null, publicMode: boolean): boolean {
  return job?.kind === "photos" && Boolean(job.photoArticles)
    && (!publicMode || job.status === "succeeded" || job.status === "partial");
}
