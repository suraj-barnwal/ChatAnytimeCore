const IMAGE_LIMIT = 490 * 1024;
const VIDEO_LIMIT = 900 * 1024;

export type MediaCompressionProgress = (message: string) => void;

function extension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > -1 ? name.slice(dot) : "";
}

function renamedFile(file: File, blob: Blob, suffix: string, type: string): File {
    const baseName = file.name.replace(/\.[^.]*$/, "") || "attachment";
    return new File([blob], `${baseName}${suffix}`, { type, lastModified: file.lastModified });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("This image format could not be compressed in your browser.")),
        type,
        quality
    ));
}

async function compressImage(file: File, report: MediaCompressionProgress): Promise<File> {
    if (file.size < IMAGE_LIMIT) return file;
    if (!("createImageBitmap" in window)) throw new Error("This browser cannot compress this image format.");

    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error("This image format cannot be compressed by this browser.");
    }

    try {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Could not prepare the image for compression.");
        let scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
        let quality = 0.82;

        for (let attempt = 0; attempt < 20; attempt++) {
            report(`Compressing image (${attempt + 1}/20)…`);
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const blob = await canvasBlob(canvas, "image/webp", quality);
            if (blob.size < IMAGE_LIMIT) return renamedFile(file, blob, ".webp", "image/webp");
            if (quality > 0.4) quality -= 0.12;
            else {
                quality = 0.76;
                scale *= 0.82;
            }
        }
        throw new Error("This image could not be reduced below 500 KB.");
    } finally {
        bitmap.close();
    }
}

function loadVideo(video: HTMLVideoElement, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("This video format cannot be compressed by this browser."));
        video.src = url;
        video.load();
    });
}

async function recordVideo(video: HTMLVideoElement, width: number, height: number, bitrate: number, mimeType: string): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the video for compression.");
    const canvasStream = canvas.captureStream(20);
    const sourceStream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream();
    const stream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...sourceStream.getAudioTracks()
    ]);
    const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 32_000
    });
    const chunks: BlobPart[] = [];
    let animationFrame = 0;
    const result = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = () => reject(new Error("The browser could not compress this video."));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
        video.onended = () => { if (recorder.state !== "inactive") recorder.stop(); };
        const drawFrame = () => {
            if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                context.drawImage(video, 0, 0, width, height);
            }
            if (!video.ended) animationFrame = requestAnimationFrame(drawFrame);
        };
        video.currentTime = 0;
        recorder.start(250);
        animationFrame = requestAnimationFrame(drawFrame);
        video.play().catch(() => reject(new Error("The browser could not play this video for compression.")));
    });

    try {
        return await result;
    } finally {
        cancelAnimationFrame(animationFrame);
        if (recorder.state !== "inactive") recorder.stop();
        stream.getTracks().forEach((track) => track.stop());
        canvasStream.getTracks().forEach((track) => track.stop());
        sourceStream.getTracks().forEach((track) => track.stop());
        video.pause();
    }
}

async function compressVideo(file: File, report: MediaCompressionProgress): Promise<File> {
    if (file.size < VIDEO_LIMIT) return file;
    if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream || !("captureStream" in HTMLMediaElement.prototype)) {
        throw new Error("Video compression is not supported in this browser. Try a recent version of Chrome or Edge.");
    }
    const mimeType = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"]
        .find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This browser does not support compressed video attachments.");

    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        await loadVideo(video, url);
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("Could not read this video's duration.");
        const originalWidth = video.videoWidth || 1280;
        const originalHeight = video.videoHeight || 720;
        const duration = video.duration;
        let bitrate = Math.max(8_000, Math.floor((VIDEO_LIMIT * 8 * 0.72) / duration) - 32_000);

        for (let attempt = 0; attempt < 4; attempt++) {
            const maxDimension = [960, 720, 480, 360][attempt];
            const scale = Math.min(1, maxDimension / Math.max(originalWidth, originalHeight));
            report(`Compressing video (${attempt + 1}/4)…`);
            const blob = await recordVideo(video, Math.max(2, Math.round(originalWidth * scale)), Math.max(2, Math.round(originalHeight * scale)), bitrate, mimeType);
            if (blob.size < VIDEO_LIMIT) return renamedFile(file, blob, ".webm", "video/webm");
            bitrate = Math.max(5_000, Math.floor(bitrate * (VIDEO_LIMIT / blob.size) * 0.78));
        }
        throw new Error("This video could not be reduced below 1 MB. Try trimming its duration.");
    } finally {
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
    }
}

export async function compressAttachment(file: File, report: MediaCompressionProgress): Promise<File> {
    const ext = extension(file.name).toLowerCase();
    if (file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/.test(ext)) return compressImage(file, report);
    if (file.type.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|3gp|m4v|mpeg|mpg)$/.test(ext)) return compressVideo(file, report);
    return file;
}

export function attachmentSizeLabel(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function attachmentExtension(name: string): string {
    return extension(name);
}

export function isImageOrVideoAttachment(file: File): boolean {
    const ext = extension(file.name).toLowerCase();
    return file.type.startsWith("image/") || file.type.startsWith("video/") ||
        /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/.test(ext) ||
        /\.(mp4|mov|webm|mkv|avi|3gp|m4v|mpeg|mpg)$/.test(ext);
}
