import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactInput } from "./public-store";

let client: S3Client | undefined;
function r2(): S3Client {
  if (!client) {
    const account = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!account || !accessKeyId || !secretAccessKey) throw new Error("R2 のサーバー設定がありません。");
    client = new S3Client({
      region: "auto", endpoint: `https://${account}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return client;
}

function bucket(): string {
  const name = process.env.R2_BUCKET_NAME;
  if (!name) throw new Error("R2_BUCKET_NAME が設定されていません。");
  return name;
}

export async function uploadArtifact(file: string, input: Omit<ArtifactInput, "byte_size">): Promise<ArtifactInput> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("成果物が見つかりません。");
  const upload = new Upload({
    client: r2(),
    params: { Bucket: bucket(), Key: input.object_key, Body: createReadStream(file), ContentType: input.mime_type },
    queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false,
  });
  await upload.done();
  return { ...input, byte_size: info.size };
}

export async function deleteArtifact(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function signedArtifactUrl(key: string, filename?: string): Promise<string> {
  const disposition = filename
    ? `attachment; filename="download.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`
    : "inline";
  return getSignedUrl(r2(), new GetObjectCommand({
    Bucket: bucket(), Key: key, ResponseContentDisposition: disposition,
  }), { expiresIn: 300 });
}
