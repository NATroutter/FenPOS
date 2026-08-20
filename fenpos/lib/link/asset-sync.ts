import "server-only";
import { listAssets, rasterFor } from "@/lib/assets/asset-service";
import {
	type AssetRaster,
	assetRasterSchema,
	type DeviceConfig,
	IMAGE_LIMITS,
	MAX_FRAME_BYTES,
} from "@/lib/link/protocol";
import { logger } from "@/lib/logger";
import { dotWidth } from "@/lib/markup/blocks";

/**
 * Which dithered rasters an agent is sent with its device configuration.
 *
 * **The source image is stored; the raster is derived; the agent receives only the raster.** A
 * thermal head has one ink and no greys, so every stored image has to be reduced to dots before it
 * can print — and this server does that reduction, once per paper width, so the panel's preview and
 * the paper cannot disagree. What crosses the link is therefore dots, not a PNG, and the agent needs
 * no image decoder at all.
 *
 * They travel with `config.sync` because that is what they are: something an agent must hold before
 * a job arrives, changing rarely, and pushed as a whole snapshot so a agent that missed a change
 * converges without either side tracking what the other has seen. The alternative — putting a logo's
 * dots in every job that prints it — pays for the same kilobytes on every receipt.
 *
 * Separate from `agent-connection.ts` because what belongs here is a policy rather than a step:
 * which widths an agent needs, in what order, and how many of them fit in one frame. Those decisions
 * are worth reading and testing on their own.
 */

/**
 * Head-room left inside {@link MAX_FRAME_BYTES} when deciding how many rasters fit.
 *
 * The budget below is computed from the frame this function is actually building rather than from an
 * estimate, so this is not a guess about content — it covers the punctuation JSON adds around the
 * entries as they are appended, which is a handful of bytes each. A kilobyte is far more than that
 * and costs nothing, whereas a frame one byte over the cap is refused whole and takes the device
 * configuration down with it.
 */
const FRAME_HEADROOM_BYTES = 1024;

/**
 * Builds the rasters for one agent's devices.
 *
 * One per stored image per distinct paper width behind that agent: an install with an 80mm and a
 * 58mm printer receives two of each, because a raster dithered for one is not a picture on the
 * other — downscaling dots that have already been reduced to black and white resamples the dither's
 * own noise. Devices sharing a width share a raster, so the common install sends one each.
 *
 * **Nothing here may prevent the device configuration reaching the agent.** An image that will not
 * dither is skipped and logged rather than raised, and rasters stop being added once the frame is
 * full, because the alternative to a receipt printing without its logo is every printer behind this
 * agent going unconfigured. A job naming a raster that was not sent fails with the agent's own
 * message, which names the image and the width.
 *
 * **The work is bounded, because this is not free and it runs on every connect.** Dithering is real
 * arithmetic over every dot, so at most {@link IMAGE_LIMITS.maxSyncedRasters} pairs of image and
 * width are prepared at all — which is also the most the frame will carry. Images past that point in
 * name order are not synced, and are named in the log rather than left to be discovered from a
 * receipt.
 *
 * @param devices the agent's devices, exactly as they will be sent
 * @param agentId the agent, for the log lines
 * @returns the rasters to include, ordered by name and then by width
 */
export async function rastersFor(devices: readonly DeviceConfig[], agentId: string): Promise<AssetRaster[]> {
	const widths = [...new Set(devices.map((device) => dotWidth(device.columns)))].sort((a, b) => a - b);
	if (widths.length === 0) {
		return [];
	}

	const assets = await listAssets();
	if (assets.length === 0) {
		return [];
	}

	// Measured against the frame being built rather than against a figure derived from the limits,
	// because the device set is what actually varies: 256 devices with long port paths leave far less
	// room than the two a shop has.
	let remaining =
		MAX_FRAME_BYTES -
		FRAME_HEADROOM_BYTES -
		Buffer.byteLength(JSON.stringify({ type: "config.sync", devices, assets: [] }), "utf8");

	const rasters: AssetRaster[] = [];
	let considered = 0;
	for (const asset of assets) {
		for (const widthDots of widths) {
			// Counted as considered rather than as accepted, which is what bounds the *work*: this
			// runs on every connect and every device edit, and dithering is not cheap. Counting only
			// what fits would let a library of images that all turn out to be unsendable cost a
			// dither each, every time, for nothing.
			if (considered >= IMAGE_LIMITS.maxSyncedRasters) {
				logger.warn("Stopped syncing images at the frame's limit", {
					agentId,
					synced: rasters.length,
					limit: IMAGE_LIMITS.maxSyncedRasters,
				});
				return rasters;
			}
			considered++;

			const entry = await encoded(asset.name, widthDots, agentId);
			if (!entry) {
				continue;
			}

			const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
			if (size > remaining) {
				// Skipped rather than stopped: a later asset may still fit, and an operator whose
				// small logos all sync except one enormous one has a clearer picture than one whose
				// images stop arriving at an arbitrary point.
				logger.warn("Skipped an image that did not fit the configuration frame", {
					agentId,
					name: asset.name,
					widthDots,
					bytes: size,
				});
				continue;
			}

			remaining -= size;
			rasters.push(entry);
		}
	}

	return rasters;
}

/**
 * Dithers one image for one width and encodes it for the wire.
 *
 * @param name the asset's name
 * @param widthDots the paper width to dither for
 * @param agentId the agent, for the log line
 * @returns the wire entry, or null if this image could not be turned into one
 */
async function encoded(name: string, widthDots: number, agentId: string): Promise<AssetRaster | null> {
	try {
		const raster = await rasterFor(name, widthDots);
		const entry = {
			name,
			widthDots: raster.widthDots,
			heightDots: raster.heightDots,
			data: raster.packed.toString("base64"),
		};

		// Checked against the schema here rather than left to the frame. An image far taller than any
		// receipt would otherwise be added, and the whole `config.sync` would then fail validation on
		// the way out — costing every printer behind this agent its configuration over one picture.
		const checked = assetRasterSchema.safeParse(entry);
		if (!checked.success) {
			logger.warn("Skipped an image the protocol will not carry", {
				agentId,
				name,
				widthDots,
				heightDots: entry.heightDots,
				problems: checked.error.issues.map((issue) => issue.message),
			});
			return null;
		}
		return checked.data;
	} catch (error) {
		// A row deleted between the listing and the read, or bytes that no longer decode. Either way
		// this is one image, and the rest of the configuration is still worth pushing.
		logger.error("Could not dither a stored image for an agent", error, { agentId, name, widthDots });
		return null;
	}
}
