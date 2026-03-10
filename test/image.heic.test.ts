import { afterEach, describe, expect, it } from "vitest";
import {
  ImageImportError,
  isHeicFile,
  isImageImportError,
  isValidImageFile,
  normalizeImageFileForImport,
  resetHeicTranscoderForTests,
  setHeicTranscoderForTests,
} from "@/utils/image";

describe("HEIC image helpers", () => {
  afterEach(() => {
    resetHeicTranscoderForTests();
  });

  it("recognizes HEIC/HEIF by extension when MIME is missing or uppercase", () => {
    expect(isHeicFile(new File(["x"], "IMG_0001.HEIC"))).toBe(true);
    expect(isHeicFile(new File(["x"], "IMG_0002.heif"))).toBe(true);
    expect(isValidImageFile(new File(["x"], "IMG_0003.HEIF"))).toBe(true);
  });

  it("does not treat a normalized JPEG payload as HEIC when MIME is explicit", () => {
    const file = new File(["x"], "IMG_0004.HEIC", { type: "image/jpeg" });
    expect(isHeicFile(file)).toBe(false);
    expect(isValidImageFile(file)).toBe(true);
  });

  it("passes through standard image files without transcoding", async () => {
    const file = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    const normalized = await normalizeImageFileForImport(file);
    expect(normalized.file).toBe(file);
    expect(normalized.originalFile).toBe(file);
    expect(normalized.isTranscoded).toBe(false);
  });

  it("transcodes HEIC files into browser-decodable JPEG files", async () => {
    setHeicTranscoderForTests(async () => {
      return new Blob(["jpeg"], { type: "image/jpeg" });
    });
    const file = new File(["heic"], "sample.HEIC");

    const normalized = await normalizeImageFileForImport(file);

    expect(normalized.originalFile).toBe(file);
    expect(normalized.isTranscoded).toBe(true);
    expect(normalized.file).not.toBe(file);
    expect(normalized.file.type).toBe("image/jpeg");
    expect(normalized.file.name).toBe("sample.HEIC");
  });

  it("surfaces a dedicated HEIC decode error when transcoding fails", async () => {
    setHeicTranscoderForTests(async () => {
      throw new Error("decoder crashed");
    });
    const file = new File(["heic"], "broken.heic");

    await expect(normalizeImageFileForImport(file)).rejects.toBeInstanceOf(
      ImageImportError,
    );
    await expect(normalizeImageFileForImport(file)).rejects.toMatchObject({
      code: "heic-transcode-failed",
    });

    try {
      await normalizeImageFileForImport(file);
    } catch (error) {
      expect(isImageImportError(error, "heic-transcode-failed")).toBe(true);
    }
  });
});
