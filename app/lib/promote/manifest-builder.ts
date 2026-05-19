/**
 * Promotion Manifest Builder
 *
 * This builder deals with the R2 manifest payload that ties a
 * promoted archival description back to the IIIF pages it originated
 * from. Writes are atomic per volume so a half-written manifest never
 * surfaces on the public site.
 *
 * @version v0.3.0
 */

import type { ManifestSpec, VolumePage } from "./types";

/**
 * Build a IIIF Presentation API v3 manifest for a single promoted document,
 * selecting the relevant pages from the parent volume's page list.
 *
 * Uses "full" region in all image URLs for Level 0 compatibility (Pitfall 3).
 * Visual cropping for partial-page boundaries is handled by the viewer client.
 */
export function buildDocumentManifest(
  spec: ManifestSpec,
  volumePages: VolumePage[],
  baseUrl: string
): object {
  const effectiveEndPage = spec.endPage ?? spec.startPage;
  const selectedPages = volumePages.filter(
    (p) => p.position >= spec.startPage && p.position <= effectiveEndPage
  );

  const canvases = selectedPages.map((page, i) => ({
    id: `${baseUrl}/${spec.referenceCode}/canvas/${i + 1}`,
    type: "Canvas",
    label: { none: [`img ${i + 1}`] },
    width: page.width,
    height: page.height,
    items: [
      {
        id: `${baseUrl}/${spec.referenceCode}/canvas/${i + 1}/page`,
        type: "AnnotationPage",
        items: [
          {
            id: `${baseUrl}/${spec.referenceCode}/canvas/${i + 1}/annotation`,
            type: "Annotation",
            motivation: "painting",
            body: {
              id: `${page.imageUrl}/full/max/0/default.jpg`,
              type: "Image",
              format: "image/jpeg",
              width: page.width,
              height: page.height,
              service: [
                {
                  id: page.imageUrl,
                  type: "ImageService3",
                  profile: "level0",
                },
              ],
            },
            target: `${baseUrl}/${spec.referenceCode}/canvas/${i + 1}`,
          },
        ],
      },
    ],
  }));

  return {
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: `${baseUrl}/${spec.referenceCode}/manifest.json`,
    type: "Manifest",
    label: { es: [spec.title] },
    rights: "http://creativecommons.org/licenses/by-nc/4.0/",
    items: canvases,
  };
}
