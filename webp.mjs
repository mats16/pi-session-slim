// PNG to lossy WebP. index.ts runs this file as a worker so pi's UI never waits on the codec.
// Plain JavaScript: Node does not strip types from a worker file under node_modules.
import { readFileSync } from "node:fs";
import { isMainThread, parentPort } from "node:worker_threads";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";

// The codecs fetch() their .wasm in a browser; in Node they are handed the compiled module.
const wasm = (entry, file) => WebAssembly.compile(readFileSync(new URL(file, import.meta.resolve(entry))));
const ready = Promise.all([
	wasm("@jsquash/png/decode.js", "./codec/pkg/squoosh_png_bg.wasm").then(initPng),
	wasm("@jsquash/webp/encode.js", "./codec/enc/webp_enc.wasm").then(initWebpEncode),
	wasm("@jsquash/webp/decode.js", "./codec/dec/webp_dec.wasm").then(initWebpDecode),
]);

/** base64 PNG to base64 WebP. Throws unless the WebP opens with the PNG's width and height. */
export async function toWebp(base64, quality) {
	await ready;
	const image = await decodePng(Buffer.from(base64, "base64"));
	const webp = Buffer.from(await encodeWebp(image, { quality }));
	const back = await decodeWebp(webp);
	if (back.width !== image.width || back.height !== image.height) throw new Error("WebP size differs from the PNG");
	return webp.toString("base64");
}

if (!isMainThread) {
	parentPort.on("message", async ({ id, data, quality }) => {
		try {
			parentPort.postMessage({ id, data: await toWebp(data, quality) });
		} catch (error) {
			parentPort.postMessage({ id, error: String(error?.message ?? error) });
		}
	});
}
