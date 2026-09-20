import { describe, expect, test } from "bun:test";
import type { Generation } from "@higgsfield/fnf/client";
import {
  generationToAssetItem,
  generationToGalleryItem,
  mediaRefToAssetItem,
} from "../src/lib/higgsfield-generation-results";

describe("Studio generation mapping", () => {
  test("keeps thumbnail-less video in a video element and its persisted project", () => {
    const item = generationToGalleryItem(
      {
        id: "video-1",
        model: "seedance_2_0",
        type: "video",
        status: "completed",
        createdAt: 1_750_000_000,
        input: { model: "seedance_2_0", settings: { aspectRatio: "16:9" } },
        results: { rawUrl: "https://cdn.example/video.mp4" },
      } satisfies Generation,
      "project-1",
    );

    expect(item).toMatchObject({
      src: "",
      videoSrc: "https://cdn.example/video.mp4",
      projectId: "project-1",
      createdAt: 1_750_000_000,
    });
  });

  test("maps persisted media refs into the Uploads tab", () => {
    expect(
      mediaRefToAssetItem({ id: "media-123456789", type: "image", url: "https://cdn/x.png" }),
    ).toMatchObject({
      name: "Upload media-12",
      kind: "upload",
      src: "https://cdn/x.png",
      ref: { id: "media-123456789", type: "media_input" },
    });
  });

  test("maps generated videos to reusable job references", () => {
    const item = generationToAssetItem({
      id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
      model: "seedance_2_0",
      type: "video",
      status: "completed",
      input: { model: "seedance_2_0", settings: {} },
      results: { rawUrl: "https://cdn.example/video.mp4" },
    } satisfies Generation);

    expect(item?.ref).toEqual({
      id: "97cf1fec-77a9-4627-a3d4-23a09ea8aaa4",
      type: "video_job",
      url: "https://cdn.example/video.mp4",
    });
  });

  test("maps generated images to reusable job references", () => {
    const item = generationToAssetItem({
      id: "b2bdc14f-96a0-4df8-854d-4d17358bc559",
      model: "gpt_image_2",
      type: "image",
      status: "completed",
      input: { model: "gpt_image_2", settings: {} },
      results: {
        rawUrl: "https://cdn.example/image.png",
        minUrl: "https://cdn.example/image-preview.webp",
      },
    } satisfies Generation);

    expect(item).toMatchObject({
      src: "https://cdn.example/image-preview.webp",
      ref: {
        id: "b2bdc14f-96a0-4df8-854d-4d17358bc559",
        type: "image_job",
        url: "https://cdn.example/image.png",
      },
    });
  });

  test("keeps terminal failures visible instead of dropping their tiles", () => {
    const item = generationToGalleryItem({
      id: "video-failed",
      model: "seedance_2_0",
      type: "video",
      status: "failed",
      failReason: "Reference image was rejected",
      input: { model: "seedance_2_0", settings: { aspectRatio: "9:16" } },
      results: {},
    } satisfies Generation);

    expect(item).toMatchObject({
      id: "video-failed",
      status: "failed",
      failureLabel: "Reference image was rejected",
      width: 9,
      height: 16,
    });
  });
});
