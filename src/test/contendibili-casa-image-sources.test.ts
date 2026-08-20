import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractDetailImageRefs,
  listingImageSourceInput,
  listingPhotoSource,
} from "../../supabase/functions/_shared/detailImageRefs";

const root = resolve(__dirname, "../..");
const certify = readFileSync(
  resolve(root, "supabase/functions/civiko-contendibili-image-certify/index.ts"),
  "utf8",
);
const selection = readFileSync(
  resolve(root, "supabase/functions/civiko-contendibili-image-certify/selection.ts"),
  "utf8",
);
const backfill = readFileSync(
  resolve(root, "supabase/migrations/20260820130000_casa_image_refs_and_empty_publish.sql"),
  "utf8",
);

const CASA_JPG = "https://images-1.casa.it/800x600/listing/0/a2/60/3b/759546585.jpg";

describe("Casa / portal photo sources — extractor", () => {
  it("reads raw_json.image, images, photos and media.images", () => {
    expect(extractDetailImageRefs({ image: CASA_JPG })).toEqual([CASA_JPG]);
    expect(extractDetailImageRefs({ images: [CASA_JPG] })).toEqual([CASA_JPG]);
    expect(extractDetailImageRefs({ photos: [{ url: CASA_JPG }] })).toEqual([CASA_JPG]);
    expect(
      extractDetailImageRefs({
        media: { images: [{ url: "https://pwm.im-cdn.it/image/1972339280/xxl.jpg" }] },
      }),
    ).toEqual(["https://pwm.im-cdn.it/image/1972339280/xxl.jpg"]);
  });

  it("listingPhotoSource sees Casa image even when media.images is absent", () => {
    const casa = { image: CASA_JPG, title: "Trilocale in centro" };
    expect(listingPhotoSource(casa)).toEqual([CASA_JPG]);
    expect(listingPhotoSource({ media: { images: null }, title: "x" })).toBeNull();
    const fp = listingImageSourceInput(casa, null);
    expect(fp.photos).toEqual([CASA_JPG]);
  });

  it("also reads ev_image_refs written by the Casa backfill", () => {
    const refs = extractDetailImageRefs({
      ev_image_refs: [{ url: CASA_JPG, kind: "detail", source: "raw_json.image" }],
    });
    expect(refs).toEqual([CASA_JPG]);
  });
});

describe("image-certify candidate pool", () => {
  it("selects listings with ev_image_refs or raw_json.image, not only media.images", () => {
    expect(selection).toContain("raw_json->image.not.is.null");
    expect(selection).toContain("ev_image_refs.not.is.null");
    expect(selection).toContain("raw_json->media->images.not.is.null");
    expect(selection).toContain("raw_json->photos.not.is.null");
    expect(certify).toContain("LISTING_PHOTO_SOURCE_OR");
    expect(certify).toContain("listingPhotoSource");
    expect(certify).not.toContain('.not("raw_json->media->images", "is", null)');
  });

  it("pairs_only can replace civiko_listing_photo_pair_evidence after fingerprints exist", () => {
    expect(certify).toContain('sb.rpc("civiko_replace_photo_pair_evidence"');
    expect(certify).toContain("pairFromStored");
    expect(certify).toContain('error: "no_fingerprints"');
    expect(certify).toContain("identity_starved: true");
    expect(certify).not.toMatch(/ok:\s*true[\s\S]{0,180}note:\s*"no_reusable_photo_sources"/);
  });
});

describe("migration 20260820130000 — Casa backfill + empty publish", () => {
  it("backfills ev_image_refs from raw_json.image without a new database", () => {
    expect(backfill).toContain("raw_json->>'image'");
    expect(backfill).toContain("source', 'raw_json.image'");
    expect(backfill).toContain("ev_image_refs IS NULL");
    expect(backfill).not.toMatch(/central-core-prod|CREATE DATABASE/i);
    expect(backfill).not.toMatch(/APIFY|SERVICE_ROLE|eyJ/);
  });

  it("wrapper does not treat 0 contendibili / 0 pair evidence as success", () => {
    expect(backfill).toContain("identity_starved");
    expect(backfill).toContain("empty_photo_publish");
    expect(backfill).toContain("v_ok := v_after > 0 AND v_pairs > 0");
    expect(backfill).toContain("padova_recompute_last_result");
  });
});
