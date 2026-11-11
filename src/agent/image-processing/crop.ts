// Cropping a horizontal band out of a rendered page (the figure finder's
// textbook pages: show the figure and its caption, not the body text around it).
import type * as Photon from "@silvia-odwyer/photon-node";
import { loadPhoton } from "./photon.mjs";

/**
 * The band of `bytes` (a PNG or JPEG) between `top` and `bottom`, each a fraction
 * of the picture's height (0 = top edge, 1 = bottom edge), full width, as PNG.
 * Null when Photon is unavailable, the bytes cannot be decoded, or the band is
 * too thin to be a picture.
 */
export async function cropVerticalBand(bytes: Uint8Array, top: number, bottom: number): Promise<Uint8Array | null> {
	if (!(top >= 0 && bottom <= 1 && bottom > top)) return null;
	const photon = (await loadPhoton()) as typeof Photon | null;
	if (!photon) return null;
	let image: Photon.PhotonImage | null = null;
	let band: Photon.PhotonImage | null = null;
	try {
		image = photon.PhotonImage.new_from_byteslice(bytes);
		const width = image.get_width();
		const height = image.get_height();
		const y1 = Math.max(0, Math.floor(top * height));
		const y2 = Math.min(height, Math.ceil(bottom * height));
		if (y2 - y1 < 16) return null;
		band = photon.crop(image, 0, y1, width, y2);
		return band.get_bytes();
	} catch {
		return null;
	} finally {
		band?.free();
		image?.free();
	}
}
